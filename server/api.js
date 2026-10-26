import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  all, get, run, tx, getSetting, setSetting, hashPassword, checkPassword, today, nowStr, ymd, UPLOAD_DIR, withDb,
} from './db.js';
import { login, logout, requireAuth, requireChief } from './auth.js';
import { notify, notifyMerged, chiefIds, cleanerIds, saveSubscription, vapidPublicKey } from './notify.js';
import { createCleaning, fillChecklist, describe, ruDate, TYPE_LABEL } from './cleanings.js';
import { syncIcal } from './ical.js';

export const api = express.Router();

const multerFor = (fileSize) => multer({
  storage: multer.diskStorage({
    // файлы демо-сессии лежат в её папке и удаляются вместе с ней
    destination: (req, file, cb) => cb(null, req.demo ? req.demo.dir : UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname || '').toLowerCase()),
  }),
  limits: { fileSize },
  fileFilter: (req, file, cb) => cb(null, /^(video|image)\//.test(file.mimetype)),
});
const realUpload = multerFor(4 * 1024 ** 3);
const demoUpload = multerFor(300 * 1024 ** 2);

// Разбор файлов идёт в событиях потока, где теряется контекст демо-базы, — возвращаем его перед обработчиком
const upload = Object.fromEntries(['array', 'single'].map((kind) => [kind, (...args) => {
  const real = realUpload[kind](...args);
  const demo = demoUpload[kind](...args);
  return (req, res, next) => (req.demo ? demo : real)(req, res, (err) =>
    err ? next(err) : req.demo ? withDb(req.demo.db, () => next()) : next());
}]));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
// Express 5 сам ловит ошибки из async-обработчиков
const isChief = (req) => req.user.role === 'chief';

function saveMedia(files, ownerType, ownerId, userId, itemId = null) {
  for (const f of files || []) {
    run(`INSERT INTO media(owner_type, owner_id, kind, filename, original_name, mime, size, uploaded_by, item_id)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ownerType, ownerId, f.mimetype.startsWith('video/') ? 'video' : 'photo',
      path.relative(UPLOAD_DIR, f.path), Buffer.from(f.originalname, 'latin1').toString('utf8'), f.mimetype, f.size, userId, itemId);
  }
}
const mediaOf = (type, id) => all(
  `SELECT m.id, m.kind, m.original_name, m.size, m.mime, m.expired, m.created_at, m.uploaded_by, m.item_id, u.name AS uploaded_by_name
   FROM media m LEFT JOIN users u ON u.id = m.uploaded_by
   WHERE owner_type = ? AND owner_id = ? ORDER BY m.id`, type, id);

// ================= auth =================
api.post('/login', login);
api.post('/logout', logout);
api.use(requireAuth);

api.get('/me', (req, res) => {
  const apartment = getSetting('apartment');
  if (!isChief(req)) delete apartment.access;
  const users = all('SELECT id, name, role, color, active FROM users ORDER BY role, name');
  res.json({ user: req.user, apartment, users, vapidPublicKey, today: today() });
});

api.get('/summary', (req, res) => {
  const u = req.user;
  const out = {
    unread: get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', u.id).n,
    purchases: get("SELECT COUNT(*) n FROM purchases WHERE status = 'needed'").n,
    problems: get("SELECT COUNT(*) n FROM problems WHERE status = 'open'").n,
  };
  if (u.role === 'cleaner') {
    out.pending = get("SELECT COUNT(*) n FROM cleanings WHERE cleaner_id = ? AND status = 'assigned'", u.id).n;
  } else {
    out.attention = get(`SELECT COUNT(*) n FROM cleanings WHERE status IN ('unassigned','declined') AND date >= ?`, today()).n;
  }
  res.json(out);
});

// ================= cleanings =================
const CLEANING_SELECT = `
  SELECT c.*, u.name AS cleaner_name, u.color AS cleaner_color,
    (SELECT COUNT(*) FROM checklist_items WHERE cleaning_id = c.id) AS total_items,
    (SELECT COUNT(*) FROM checklist_items WHERE cleaning_id = c.id AND done = 1) AS done_items,
    (SELECT COUNT(*) FROM media WHERE owner_type = 'cleaning' AND owner_id = c.id AND kind = 'video') AS videos
  FROM cleanings c LEFT JOIN users u ON u.id = c.cleaner_id`;

function loadCleaning(req, id) {
  const c = get(`${CLEANING_SELECT} WHERE c.id = ?`, id);
  if (!c) fail(404, 'Уборка не найдена');
  if (!isChief(req) && c.cleaner_id !== req.user.id) fail(403, 'Эта уборка назначена не вам');
  return c;
}

api.get('/cleanings', (req, res) => {
  const { from = '0000-00-00', to = '9999-99-99', status } = req.query;
  const where = ['c.date BETWEEN ? AND ?'];
  const params = [from, to];
  if (!isChief(req)) { where.push('c.cleaner_id = ?'); params.push(req.user.id); }
  if (status) { where.push(`c.status IN (${status.split(',').map(() => '?').join(',')})`); params.push(...status.split(',')); }
  const rows = all(`${CLEANING_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.date, c.start_time`, ...params);
  if (isChief(req)) {
    for (const c of rows) {
      if (['unassigned', 'declined'].includes(c.status) && c.date >= today()) c.suggested = candidatesFor(c).find((x) => x.suggested) || null;
    }
  }
  res.json(rows);
});

/**
 * Кто может взять уборку: свободна в этот день, нет другой уборки, не отказывалась от этой.
 * Первой предлагаем ту, у кого меньше уборок в этом месяце — нагрузка распределяется ровнее.
 */
function candidatesFor(c) {
  const month = c.date.slice(0, 7);
  const list = all(`SELECT u.id, u.name, u.color,
      EXISTS(SELECT 1 FROM unavailability WHERE user_id = u.id AND date = ?) AS unavailable,
      EXISTS(SELECT 1 FROM cleanings WHERE cleaner_id = u.id AND date = ? AND id != ? AND status != 'cancelled') AS busy,
      (SELECT COUNT(*) FROM cleanings WHERE cleaner_id = u.id AND substr(date, 1, 7) = ? AND status != 'cancelled') AS load
    FROM users u WHERE u.role = 'cleaner' AND u.active = 1 ORDER BY u.name`, c.date, c.date, c.id, month);
  for (const x of list) {
    x.declined = c.status === 'declined' && c.cleaner_id === x.id;
    x.free = !x.unavailable && !x.busy && !x.declined;
  }
  const best = list.filter((x) => x.free).sort((a, b) => a.load - b.load)[0];
  if (best) best.suggested = true;
  return list;
}

api.get('/cleanings/:id/candidates', requireChief, (req, res) => {
  res.json(candidatesFor(loadCleaning(req, req.params.id)));
});

api.get('/cleanings/:id', (req, res) => {
  const c = loadCleaning(req, req.params.id);
  // код доступа: шефу всегда, уборщице — только в день своей уборки, после того как она её приняла
  const { access } = getSetting('apartment');
  const accessOpen = isChief(req) || (c.date === today() && ['accepted', 'in_progress'].includes(c.status));
  c.access = access && accessOpen ? access : null;
  c.access_exists = !!access;
  if (isChief(req) && ['unassigned', 'declined'].includes(c.status)) c.suggested = candidatesFor(c).find((x) => x.suggested) || null;
  c.checklist = all('SELECT * FROM checklist_items WHERE cleaning_id = ? ORDER BY position', c.id);
  c.media = mediaOf('cleaning', c.id);
  for (const item of c.checklist) item.photos = c.media.filter((m) => m.item_id === item.id).map((m) => m.id);
  c.problems = all(`SELECT p.*, u.name AS author FROM problems p JOIN users u ON u.id = p.created_by
                    WHERE cleaning_id = ? ORDER BY p.id DESC`, c.id);
  c.purchases = all(`SELECT p.*, u.name AS author FROM purchases p JOIN users u ON u.id = p.created_by
                     WHERE cleaning_id = ? ORDER BY p.id DESC`, c.id);
  res.json(c);
});

// Состояние квартиры для шефа: идёт уборка / грязно / гости в квартире / готова к заселению
// Состояние квартиры для шефа: идёт уборка / гости проживают / грязно / готова к заселению.
// Источники: уборки, проживания из бронирований (iCal) и отметки шефа «заселились / выехали / уже убрано».
api.get('/apartment-status', requireChief, (req, res) => {
  const t = today();
  const now = nowStr().slice(0, 16);
  const hm = now.slice(11, 16);
  const times = getSetting('times');
  const PENDING = "c.status IN ('unassigned','assigned','accepted','declined')";
  const pendingFrom = (date) => get(`${CLEANING_SELECT} WHERE ${PENDING} AND c.date >= ? ORDER BY c.date, c.start_time LIMIT 1`, date) || null;
  const last = get(`${CLEANING_SELECT} WHERE c.status = 'done' ORDER BY c.finished_at DESC LIMIT 1`) || null;
  const manualClean = getSetting('manual_clean_at');
  const cleanedAt = [last?.finished_at, manualClean].filter(Boolean).sort().at(-1) || '';
  const out = (state, extra = {}) => res.json({ state, last, times, manualClean, ...extra });

  const active = get(`${CLEANING_SELECT} WHERE c.status = 'in_progress' ORDER BY c.date LIMIT 1`);
  if (active) return out('cleaning', { cleaning: active });

  const stay = get('SELECT * FROM stays WHERE checkin <= ? AND checkout > ? ORDER BY checkout LIMIT 1', now, now);
  if (stay) return out('stay', { stay, cleaning: pendingFrom(stay.checkout.slice(0, 10)) });

  // уборка, время которой наступило (гости выехали), а её ещё не сделали
  const due = get(`${CLEANING_SELECT} WHERE ${PENDING}
    AND (c.date < ? OR (c.date = ? AND (c.start_time IS NULL OR c.start_time <= ?))) ORDER BY c.date LIMIT 1`, t, t, hm);
  if (due) return out('dirty', { cleaning: due });
  // гости выехали позже последней уборки
  const ended = get('SELECT * FROM stays WHERE checkout <= ? ORDER BY checkout DESC LIMIT 1', now);
  if (ended && cleanedAt < ended.checkout) return out('dirty', { ended, cleaning: pendingFrom(ended.checkout.slice(0, 10)) });

  // без данных о бронях: в день уборки до её начала гости ещё в квартире
  const today_ = get(`${CLEANING_SELECT} WHERE ${PENDING} AND c.date = ? ORDER BY c.start_time LIMIT 1`, t);
  if (today_) return out('stay', { stay: { checkout: `${t} ${today_.start_time}` }, cleaning: today_ });

  const nextStay = get('SELECT * FROM stays WHERE checkin > ? ORDER BY checkin LIMIT 1', now) || null;
  out('ready', { next: pendingFrom(t), nextStay });
});

const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
api.post('/stays', requireChief, (req, res) => {
  const { checkin, checkout } = req.body;
  if (!DT.test(checkin || '') || !DT.test(checkout || '')) fail(400, 'Укажите дату и время заезда и выезда');
  if (checkout <= checkin) fail(400, 'Выезд должен быть позже заезда');
  tx(() => {
    run("INSERT INTO stays(checkin, checkout, source) VALUES(?, ?, 'manual')", checkin, checkout);
    // в день выезда нужна уборка — создаём, если её ещё нет
    const date = checkout.slice(0, 10);
    if (!get("SELECT id FROM cleanings WHERE date = ? AND status != 'cancelled'", date)) {
      createCleaning({ date, start_time: checkout.slice(11, 16) });
    }
  });
  res.json({ ok: true });
});

api.post('/stays/:id/checkout', requireChief, (req, res) => {
  const now = nowStr().slice(0, 16);
  run('UPDATE stays SET checkout = ? WHERE id = ? AND checkout > ?', now, req.params.id, now);
  res.json({ ok: true });
});

// шеф отмечает, что квартира уже убрана (например, уборку сделали без приложения)
api.post('/apartment/cleaned', requireChief, (req, res) => {
  setSetting('manual_clean_at', nowStr());
  res.json({ ok: true });
});

api.post('/cleanings', requireChief, (req, res) => {
  const b = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) fail(400, 'Укажите дату');
  const c = tx(() => createCleaning({ ...b, cleaner_id: b.cleaner_id ? +b.cleaner_id : null }));
  if (c.cleaner_id) notify(c.cleaner_id, 'Новая уборка', `${TYPE_LABEL[c.type]} · ${describe(c)}`, `#/cleaning/${c.id}`);
  res.json(c);
});

api.patch('/cleanings/:id', requireChief, (req, res) => {
  const c = loadCleaning(req, req.params.id);
  const b = req.body;
  const next = {
    date: b.date ?? c.date,
    start_time: b.start_time !== undefined ? b.start_time || null : c.start_time,
    end_time: b.end_time !== undefined ? b.end_time || null : c.end_time,
    type: b.type ?? c.type,
    note: b.note !== undefined ? b.note || null : c.note,
    pay_amount: b.pay_amount !== undefined ? Math.round(+b.pay_amount || 0) : c.pay_amount,
    cleaner_id: b.cleaner_id !== undefined ? (b.cleaner_id ? +b.cleaner_id : null) : c.cleaner_id,
  };
  const reassigned = next.cleaner_id !== c.cleaner_id;
  let status = c.status;
  if (reassigned || c.status === 'cancelled') status = next.cleaner_id ? 'assigned' : 'unassigned';
  tx(() => {
    run(`UPDATE cleanings SET date=?, start_time=?, end_time=?, type=?, note=?, pay_amount=?, cleaner_id=?, status=?,
         decline_reason = CASE WHEN ? THEN NULL ELSE decline_reason END, reminded = CASE WHEN ? THEN 0 ELSE reminded END
         WHERE id = ?`,
      next.date, next.start_time, next.end_time, next.type, next.note, next.pay_amount, next.cleaner_id, status,
      reassigned ? 1 : 0, reassigned || next.date !== c.date ? 1 : 0, c.id);
    if (next.type !== c.type && !['in_progress', 'done'].includes(c.status)) fillChecklist(c.id, next.type);
  });
  const updated = { ...c, ...next };
  if (reassigned) {
    if (c.cleaner_id && c.status !== 'declined') notify(c.cleaner_id, 'Уборка снята с вас', describe(c), '#/');
    if (next.cleaner_id) notify(next.cleaner_id, 'Новая уборка', `${TYPE_LABEL[next.type]} · ${describe(updated)}`, `#/cleaning/${c.id}`);
  } else if (next.cleaner_id && (next.date !== c.date || next.start_time !== c.start_time || next.type !== c.type || next.note !== c.note)) {
    notify(next.cleaner_id, 'Уборка изменена', `${TYPE_LABEL[next.type]} · ${describe(updated)}`, `#/cleaning/${c.id}`);
  }
  res.json({ ok: true });
});

api.post('/cleanings/:id/cancel', requireChief, (req, res) => {
  const c = loadCleaning(req, req.params.id);
  if (c.status === 'done') fail(400, 'Уборка уже завершена');
  run("UPDATE cleanings SET status = 'cancelled' WHERE id = ?", c.id);
  if (c.cleaner_id) notify(c.cleaner_id, 'Уборка отменена', describe(c), `#/cleaning/${c.id}`);
  res.json({ ok: true });
});

api.delete('/cleanings/:id', requireChief, (req, res) => {
  const c = loadCleaning(req, req.params.id);
  if (c.payout_id) fail(400, 'Уборка уже входит в выплату — её нельзя удалить');
  for (const m of all("SELECT filename FROM media WHERE owner_type = 'cleaning' AND owner_id = ?", c.id)) {
    fs.rm(path.join(UPLOAD_DIR, m.filename), { force: true }, () => {});
  }
  tx(() => {
    run("DELETE FROM media WHERE owner_type = 'cleaning' AND owner_id = ?", c.id);
    run('DELETE FROM cleanings WHERE id = ?', c.id);
  });
  res.json({ ok: true });
});

// ----- действия уборщицы -----
function ownCleaning(req, id = req.params.id) {
  const c = loadCleaning(req, id);
  if (c.cleaner_id !== req.user.id) fail(403, 'Эта уборка назначена не вам');
  return c;
}

api.post('/cleanings/:id/accept', (req, res) => {
  const c = ownCleaning(req);
  if (!['assigned', 'declined'].includes(c.status)) fail(400, 'Уборку нельзя принять в текущем статусе');
  run("UPDATE cleanings SET status = 'accepted', decline_reason = NULL WHERE id = ?", c.id);
  notify(chiefIds(), `${req.user.name} приняла уборку`, describe(c), `#/cleaning/${c.id}`);
  res.json({ ok: true });
});

api.post('/cleanings/:id/decline', (req, res) => {
  const c = ownCleaning(req);
  if (!['assigned', 'accepted'].includes(c.status)) fail(400, 'Уборку нельзя отклонить в текущем статусе');
  const reason = String(req.body.reason || '').trim();
  run("UPDATE cleanings SET status = 'declined', decline_reason = ? WHERE id = ?", reason || null, c.id);
  run('INSERT INTO declines(cleaning_id, user_id) VALUES(?, ?)', c.id, req.user.id);
  const next = candidatesFor({ ...c, status: 'declined' }).find((x) => x.suggested);
  notify(chiefIds(), `${req.user.name} отказалась от уборки`,
    `${describe(c)}${reason ? ' — ' + reason : ''}. `
    + (next ? `Свободна ${next.name} — подтвердите замену одним нажатием.` : 'Свободных уборщиц на этот день нет.'), `#/cleaning/${c.id}`);
  res.json({ ok: true });
});

api.post('/cleanings/:id/start', (req, res) => {
  const c = ownCleaning(req);
  if (!['assigned', 'accepted'].includes(c.status)) fail(400, 'Уборку нельзя начать в текущем статусе');
  run("UPDATE cleanings SET status = 'in_progress', started_at = ? WHERE id = ?", nowStr(), c.id);
  notify(chiefIds(), `${req.user.name} начала уборку`, describe(c), `#/cleaning/${c.id}`);
  res.json({ ok: true });
});

api.post('/cleanings/:id/finish', (req, res) => {
  const c = ownCleaning(req);
  if (c.status !== 'in_progress') fail(400, 'Сначала начните уборку');
  const comment = req.body.comment !== undefined ? String(req.body.comment).trim() || null : c.comment;
  run("UPDATE cleanings SET status = 'done', finished_at = ?, comment = ? WHERE id = ?", nowStr(), comment, c.id);
  const missed = c.total_items - c.done_items;
  notify(chiefIds(), `${req.user.name} закончила уборку`,
    `${describe(c)} · чек-лист ${missed ? `${c.done_items} из ${c.total_items} — не выполнено: ${missed}` : 'выполнен полностью'}`
    + ` · видео: ${c.videos}${comment ? ' · есть комментарий' : ''}`, `#/cleaning/${c.id}`);
  res.json({ ok: true });
});

api.post('/cleanings/:id/comment', (req, res) => {
  const c = ownCleaning(req);
  run('UPDATE cleanings SET comment = ? WHERE id = ?', String(req.body.comment || '').trim() || null, c.id);
  res.json({ ok: true });
});

api.post('/checklist/:itemId/toggle', (req, res) => {
  const item = get('SELECT * FROM checklist_items WHERE id = ?', req.params.itemId);
  if (!item) fail(404, 'Пункт не найден');
  const c = ownCleaning(req, item.cleaning_id);
  if (c.status !== 'in_progress') fail(400, 'Нажмите «Начать уборку», чтобы отмечать пункты');
  if (!c.inspection) fail(400, 'Сначала осмотрите квартиру после гостей');
  if (!item.done && item.photo_required && !get('SELECT id FROM media WHERE item_id = ?', item.id)) {
    fail(400, 'Для этого пункта нужно фото');
  }
  const done = item.done ? 0 : 1;
  run('UPDATE checklist_items SET done = ?, done_at = ? WHERE id = ?', done, done ? nowStr() : null, item.id);
  res.json({ done });
});

// фото к пункту чек-листа: сохраняем и сразу отмечаем пункт выполненным
api.post('/checklist/:itemId/photo', upload.single('photo'), (req, res) => {
  const item = get('SELECT * FROM checklist_items WHERE id = ?', req.params.itemId);
  if (!item) fail(404, 'Пункт не найден');
  const c = ownCleaning(req, item.cleaning_id);
  if (c.status !== 'in_progress') fail(400, 'Нажмите «Начать уборку», чтобы отмечать пункты');
  if (!c.inspection) fail(400, 'Сначала осмотрите квартиру после гостей');
  if (!req.file) fail(400, 'Нужна фотография');
  tx(() => {
    saveMedia([req.file], 'cleaning', c.id, req.user.id, item.id);
    run('UPDATE checklist_items SET done = 1, done_at = ? WHERE id = ?', nowStr(), item.id);
  });
  res.json({ id: get('SELECT id FROM media WHERE item_id = ? ORDER BY id DESC LIMIT 1', item.id).id });
});

// осмотр после гостей — первый шаг уборки
api.post('/cleanings/:id/inspection', (req, res) => {
  const c = ownCleaning(req);
  if (c.status !== 'in_progress') fail(400, 'Сначала начните уборку');
  const result = req.body.result === 'issues' ? 'issues' : 'ok';
  run('UPDATE cleanings SET inspection = ?, inspection_at = ? WHERE id = ?', result, nowStr(), c.id);
  res.json({ ok: true });
});

api.post('/cleanings/:id/media', upload.array('files', 10), (req, res) => {
  const c = ownCleaning(req);
  if (!req.files?.length) fail(400, 'Можно загружать только видео и фото');
  saveMedia(req.files, 'cleaning', c.id, req.user.id);
  if (c.status === 'done') notify(chiefIds(), `${req.user.name} добавила видео к отчёту`, describe(c), `#/cleaning/${c.id}`);
  res.json({ ok: true });
});

// ================= media =================
api.delete('/media/:id', (req, res) => {
  const m = get('SELECT * FROM media WHERE id = ?', req.params.id);
  if (!m) fail(404, 'Файл не найден');
  if (!isChief(req) && m.uploaded_by !== req.user.id) fail(403, 'Можно удалять только свои файлы');
  fs.rm(path.join(UPLOAD_DIR, m.filename), { force: true }, () => {});
  run('DELETE FROM media WHERE id = ?', m.id);
  res.json({ ok: true });
});

// ================= purchases =================
const PURCHASE_SELECT = `
  SELECT p.*, a.name AS author, b.name AS buyer,
    (SELECT id FROM media WHERE owner_type = 'purchase' AND owner_id = p.id LIMIT 1) AS receipt_id
  FROM purchases p JOIN users a ON a.id = p.created_by LEFT JOIN users b ON b.id = p.bought_by`;

api.get('/purchases', (req, res) => {
  const status = req.query.status || 'needed';
  const order = status === 'needed' ? 'p.created_at DESC' : 'p.bought_at DESC';
  res.json(all(`${PURCHASE_SELECT} WHERE p.status = ? ORDER BY ${order} LIMIT 200`, status));
});

api.post('/purchases', (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) fail(400, 'Что нужно купить?');
  const same = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const dup = all("SELECT title FROM purchases WHERE status = 'needed'").find((p) => same(p.title) === same(title));
  if (dup) fail(400, `«${dup.title}» уже есть в списке`);
  const r = run('INSERT INTO purchases(title, note, created_by, cleaning_id) VALUES(?,?,?,?)',
    title, String(req.body.note || '').trim() || null, req.user.id, req.body.cleaning_id || null);
  const others = [...cleanerIds(), ...chiefIds()].filter((id) => id !== req.user.id);
  notify(others, 'Нужно докупить', `${title} — добавила ${req.user.name}`, '#/purchases');
  res.json({ id: Number(r.lastInsertRowid) });
});

api.post('/purchases/:id/bought', upload.single('receipt'), (req, res) => {
  const p = get('SELECT * FROM purchases WHERE id = ?', req.params.id);
  if (!p || p.status !== 'needed') fail(400, 'Покупка уже отмечена');
  const amount = Math.max(0, Math.round(+req.body.amount || 0));
  tx(() => {
    run("UPDATE purchases SET status = 'bought', bought_by = ?, bought_at = ?, amount = ? WHERE id = ?",
      req.user.id, nowStr(), amount || null, p.id);
    if (req.file) saveMedia([req.file], 'purchase', p.id, req.user.id);
  });
  if (!isChief(req)) notify(chiefIds(), `${req.user.name} купила: ${p.title}`, amount ? `${amount} ₽ — к компенсации` : '', '#/purchases');
  res.json({ ok: true });
});

api.post('/purchases/:id/restore', (req, res) => {
  const p = get('SELECT * FROM purchases WHERE id = ?', req.params.id);
  if (!p) fail(404, 'Не найдено');
  if (p.payout_id) fail(400, 'Покупка уже компенсирована');
  if (!isChief(req) && p.bought_by !== req.user.id) fail(403, 'Можно вернуть только свою покупку');
  run("UPDATE purchases SET status = 'needed', bought_by = NULL, bought_at = NULL, amount = NULL WHERE id = ?", p.id);
  res.json({ ok: true });
});

api.delete('/purchases/:id', (req, res) => {
  const p = get('SELECT * FROM purchases WHERE id = ?', req.params.id);
  if (!p) fail(404, 'Не найдено');
  if (p.payout_id) fail(400, 'Покупка уже компенсирована');
  if (!isChief(req) && p.created_by !== req.user.id) fail(403, 'Можно удалять только свои пункты');
  run('DELETE FROM purchases WHERE id = ?', p.id);
  res.json({ ok: true });
});

// ================= problems =================
api.get('/problems', (req, res) => {
  const status = req.query.status || 'open';
  const rows = all(`SELECT p.*, u.name AS author, c.date AS cleaning_date FROM problems p
    JOIN users u ON u.id = p.created_by LEFT JOIN cleanings c ON c.id = p.cleaning_id
    WHERE p.status = ? ORDER BY p.id DESC LIMIT 200`, status);
  for (const r of rows) r.media = mediaOf('problem', r.id);
  res.json(rows);
});

api.post('/problems', upload.array('photos', 10), (req, res) => {
  const kind = ['breakage', 'forgotten', 'other'].includes(req.body.kind) ? req.body.kind : 'other';
  const description = String(req.body.description || '').trim();
  if (!description) fail(400, 'Опишите проблему');
  const id = tx(() => {
    const r = run('INSERT INTO problems(kind, description, cleaning_id, created_by) VALUES(?,?,?,?)',
      kind, description, req.body.cleaning_id || null, req.user.id);
    const id = Number(r.lastInsertRowid);
    saveMedia(req.files, 'problem', id, req.user.id);
    return id;
  });
  const label = { breakage: 'Поломка', forgotten: 'Гости забыли вещь', other: 'Проблема' }[kind];
  notify(chiefIds().filter((x) => x !== req.user.id), `${label}: сообщила ${req.user.name}`, description.slice(0, 120), '#/problems');
  res.json({ id });
});

api.post('/problems/:id/resolve', requireChief, (req, res) => {
  const p = get('SELECT * FROM problems WHERE id = ?', req.params.id);
  if (!p) fail(404, 'Не найдено');
  const resolution = String(req.body.resolution || '').trim() || null;
  run("UPDATE problems SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?", resolution, nowStr(), p.id);
  if (p.created_by !== req.user.id) notify(p.created_by, 'Проблема решена', `${p.description.slice(0, 80)}${resolution ? ' — ' + resolution : ''}`, '#/problems');
  res.json({ ok: true });
});

api.post('/problems/:id/reopen', requireChief, (req, res) => {
  run("UPDATE problems SET status = 'open', resolution = NULL, resolved_at = NULL WHERE id = ?", req.params.id);
  res.json({ ok: true });
});

// ================= money =================
function balanceOf(cleanerId) {
  const cleanings = all(`SELECT id, date, type, pay_amount FROM cleanings
    WHERE cleaner_id = ? AND status = 'done' AND payout_id IS NULL ORDER BY date`, cleanerId);
  const purchases = all(`SELECT id, title, amount, bought_at FROM purchases
    WHERE bought_by = ? AND status = 'bought' AND amount > 0 AND payout_id IS NULL ORDER BY bought_at`, cleanerId);
  const cleanings_sum = cleanings.reduce((s, c) => s + c.pay_amount, 0);
  const purchases_sum = purchases.reduce((s, p) => s + p.amount, 0);
  return { cleanings, purchases, cleanings_sum, purchases_sum, total: cleanings_sum + purchases_sum };
}

function monthStats(cleanerId) {
  const month = today().slice(0, 7);
  return get(`SELECT COUNT(*) AS count, COALESCE(SUM(pay_amount), 0) AS earned FROM cleanings
    WHERE cleaner_id = ? AND status = 'done' AND substr(date, 1, 7) = ?`, cleanerId, month);
}

api.get('/money', (req, res) => {
  const ids = isChief(req)
    ? all("SELECT id FROM users WHERE role = 'cleaner' AND active = 1 ORDER BY name").map((u) => u.id)
    : [req.user.id];
  const people = ids.map((id) => ({
    ...get('SELECT id, name, color FROM users WHERE id = ?', id),
    balance: balanceOf(id),
    month: monthStats(id),
  }));
  const payouts = all(`SELECT p.*, u.name FROM payouts p JOIN users u ON u.id = p.cleaner_id
    ${isChief(req) ? '' : 'WHERE p.cleaner_id = ' + Number(req.user.id)} ORDER BY p.id DESC LIMIT 50`);
  res.json({ people, payouts });
});

api.post('/payouts', requireChief, (req, res) => {
  const cleanerId = +req.body.cleaner_id;
  const b = balanceOf(cleanerId);
  if (!b.total) fail(400, 'Нечего выплачивать');
  tx(() => {
    const r = run('INSERT INTO payouts(cleaner_id, amount, cleanings_sum, purchases_sum, note) VALUES(?,?,?,?,?)',
      cleanerId, b.total, b.cleanings_sum, b.purchases_sum, req.body.note || null);
    const id = Number(r.lastInsertRowid);
    for (const c of b.cleanings) run('UPDATE cleanings SET payout_id = ? WHERE id = ?', id, c.id);
    for (const p of b.purchases) run('UPDATE purchases SET payout_id = ? WHERE id = ?', id, p.id);
  });
  notify(cleanerId, 'Выплата', `${b.total.toLocaleString('ru-RU')} ₽: уборки ${b.cleanings.length} шт.${b.purchases_sum ? `, покупки ${b.purchases_sum} ₽` : ''}`, '#/money');
  res.json({ ok: true });
});

// ================= notifications & push =================
api.get('/notifications', (req, res) => {
  res.json(all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 60', req.user.id));
});
api.post('/notifications/read', (req, res) => {
  run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});
api.post('/push/subscribe', (req, res) => {
  if (!req.body?.endpoint) fail(400, 'Нет подписки');
  saveSubscription(req.user.id, req.body);
  res.json({ ok: true });
});

// ================= team =================
api.get('/users', requireChief, (req, res) => {
  res.json(all(`SELECT id, login, name, role, color, active, created_at,
    (SELECT COUNT(*) FROM cleanings WHERE cleaner_id = users.id AND status = 'done') AS done_count
    FROM users ORDER BY role, active DESC, name`));
});

api.post('/users', requireChief, (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9._-]{3,}$/.test(login)) fail(400, 'Логин: от 3 символов, латиница и цифры');
  if (!name) fail(400, 'Укажите имя');
  if (password.length < 6) fail(400, 'Пароль: минимум 6 символов');
  if (login === 'demo' || get('SELECT id FROM users WHERE login = ?', login)) fail(400, 'Такой логин уже есть');
  run("INSERT INTO users(login, name, role, pass_hash, color) VALUES(?,?,'cleaner',?,?)",
    login, name, hashPassword(password), req.body.color || '#8E1B33');
  res.json({ ok: true });
});

api.patch('/users/:id', requireChief, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) fail(404, 'Не найдено');
  const b = req.body;
  if (b.password !== undefined && String(b.password).length < 6) fail(400, 'Пароль: минимум 6 символов');
  if (b.active === false && u.id === req.user.id) fail(400, 'Нельзя отключить свой аккаунт');
  run('UPDATE users SET name = ?, color = ?, active = ? WHERE id = ?',
    String(b.name ?? u.name).trim() || u.name, b.color ?? u.color, b.active === undefined ? u.active : b.active ? 1 : 0, u.id);
  if (b.password) run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(String(b.password)), u.id);
  if (b.active === false || b.password) run('DELETE FROM sessions WHERE user_id = ? AND user_id != ?', u.id, req.user.id);
  res.json({ ok: true });
});

api.post('/me/password', (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!checkPassword(String(req.body.current || ''), u.pass_hash)) fail(400, 'Текущий пароль неверный');
  if (String(req.body.password || '').length < 6) fail(400, 'Пароль: минимум 6 символов');
  run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(String(req.body.password)), u.id);
  res.json({ ok: true });
});

// ================= settings =================
const SETTINGS_KEYS = ['apartment', 'times', 'rates', 'templates', 'ical', 'ical_status', 'video_retention_days'];

api.get('/settings', requireChief, (req, res) => {
  res.json(Object.fromEntries(SETTINGS_KEYS.map((k) => [k, getSetting(k)])));
});

api.put('/settings', requireChief, (req, res) => {
  for (const k of SETTINGS_KEYS) {
    if (k !== 'ical_status' && req.body[k] !== undefined) setSetting(k, req.body[k]);
  }
  res.json({ ok: true });
});

// ================= оценка уборки =================
api.post('/cleanings/:id/rating', requireChief, (req, res) => {
  const c = loadCleaning(req, req.params.id);
  if (c.status !== 'done') fail(400, 'Оценить можно завершённую уборку');
  const rating = Math.round(+req.body.rating);
  if (!(rating >= 1 && rating <= 5)) fail(400, 'Оценка от 1 до 5');
  run('UPDATE cleanings SET rating = ? WHERE id = ?', rating, c.id);
  if (c.cleaner_id && !c.rating) notify(c.cleaner_id, 'Шеф оценил уборку', `${describe(c)}: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}`, `#/cleaning/${c.id}`);
  res.json({ ok: true });
});

// ================= «не могу в эти дни» =================
api.get('/unavailability', (req, res) => {
  const { from = '0000-00-00', to = '9999-99-99' } = req.query;
  res.json(isChief(req)
    ? all(`SELECT a.user_id, a.date, u.name, u.color FROM unavailability a JOIN users u ON u.id = a.user_id
           WHERE a.date BETWEEN ? AND ? AND u.active = 1 ORDER BY a.date, u.name`, from, to)
    : all('SELECT user_id, date FROM unavailability WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date', req.user.id, from, to));
});

api.post('/unavailability/toggle', (req, res) => {
  if (isChief(req)) fail(400, 'Только для уборщиц');
  const date = String(req.body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'Неверная дата');
  if (date < today()) fail(400, 'Прошедшие дни менять нельзя');
  if (get('SELECT 1 AS x FROM unavailability WHERE user_id = ? AND date = ?', req.user.id, date)) {
    run('DELETE FROM unavailability WHERE user_id = ? AND date = ?', req.user.id, date);
    return res.json({ unavailable: false });
  }
  run('INSERT INTO unavailability(user_id, date) VALUES(?, ?)', req.user.id, date);
  notifyMerged(chiefIds(), `${req.user.name} не сможет убирать`, ruDate(date), '#/availability');
  const conflict = get(`SELECT * FROM cleanings WHERE cleaner_id = ? AND date = ? AND status IN ('assigned','accepted')`, req.user.id, date);
  res.json({ unavailable: true, conflict: conflict ? { id: conflict.id } : null });
});

// ================= статистика по уборщицам =================
api.get('/stats', requireChief, (req, res) => {
  const days = Math.max(0, +req.query.days || 0);
  const from = days ? ymd(new Date(Date.now() - days * 86400000)) : '0000-00-00';
  const minutes = (a, b) => (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 60000;
  const people = all("SELECT id, name, color, active FROM users WHERE role = 'cleaner' ORDER BY active DESC, name");
  const out = people.map((u) => {
    const list = all(`${CLEANING_SELECT} WHERE c.cleaner_id = ? AND c.status = 'done' AND c.date >= ? AND c.date <= ?`, u.id, from, today());
    const durations = list.filter((c) => c.started_at && c.finished_at)
      .map((c) => minutes(c.started_at, c.finished_at)).filter((m) => m >= 5 && m <= 12 * 60);
    // опоздание: начала позже запланированного времени больше чем на 15 минут
    const timed = list.filter((c) => c.started_at && c.start_time);
    const late = timed.filter((c) => minutes(`${c.date} ${c.start_time}:00`, c.started_at) > 15);
    const rated = list.filter((c) => c.rating);
    const withList = list.filter((c) => c.total_items);
    return {
      ...u,
      count: list.length,
      avg_minutes: durations.length ? Math.round(durations.reduce((s, m) => s + m, 0) / durations.length) : null,
      full_checklist: withList.length ? withList.filter((c) => c.done_items === c.total_items).length / withList.length : null,
      late: late.length,
      timed: timed.length,
      avg_rating: rated.length ? rated.reduce((s, c) => s + c.rating, 0) / rated.length : null,
      rated: rated.length,
      with_video: list.length ? list.filter((c) => c.videos).length / list.length : null,
      declines: get('SELECT COUNT(*) n FROM declines WHERE user_id = ? AND substr(created_at, 1, 10) >= ?', u.id, from).n,
    };
  }).filter((p) => p.active || p.count);
  res.json({ from, people: out });
});

// ================= demo =================
api.post('/demo/switch', (req, res) => {
  if (!req.demo) fail(403, 'Только для демо-доступа');
  req.demo.userId = req.body.role === 'cleaner' ? req.demo.cleanerId : req.demo.chiefId;
  res.json({ ok: true });
});

api.post('/ical/sync', requireChief, async (req, res) => {
  res.json(await syncIcal());
});

// ================= errors =================
api.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой' : err.message });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Ошибка сервера' });
});
