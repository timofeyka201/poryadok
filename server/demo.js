// Демо-доступ: при каждом входе создаётся отдельная песочница в памяти с примерными данными.
// В ней работает всё, но рабочая база не затрагивается, а сама песочница удаляется
// при выходе, через 3 часа бездействия или при перезапуске сервера.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSchema, withDb, all, get, run, today, ymd, nowStr, hashPassword, setSetting, UPLOAD_DIR } from './db.js';
import { createCleaning } from './cleanings.js';

export const DEMO_LOGIN = 'demo';
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo';
const IDLE_MS = 3 * 60 * 60 * 1000;
const MAX_SANDBOXES = 30;

const sandboxes = new Map(); // token -> { db, dir, chiefId, cleanerId, userId, lastSeen }

/** Примерные данные: уборки в разных статусах, покупки, проблемы, выплаты. Даты — относительно сегодня. */
export function seedDemoData() {
  const user = (login, name, role, color) => {
    const u = get('SELECT id FROM users WHERE login = ?', login);
    if (u) return u.id;
    return Number(run('INSERT INTO users(login, name, role, pass_hash, color) VALUES(?,?,?,?,?)',
      login, name, role, hashPassword(crypto.randomBytes(12).toString('hex')), color).lastInsertRowid);
  };
  const chief = user('shef', 'Шеф', 'chief', '#8E1B33');
  const anna = user('anna', 'Анна', 'cleaner', '#8E1B33');
  const maria = user('maria', 'Мария', 'cleaner', '#1F6FEB');
  const d = (n) => ymd(new Date(Date.now() + n * 86400000));

  const finish = (c, who, { missed = 0, comment = null, start = '11:05', end = '13:20', rating = null } = {}) => {
    run('UPDATE checklist_items SET done = 1, done_at = ? WHERE cleaning_id = ?', nowStr(), c.id);
    if (missed) run(`UPDATE checklist_items SET done = 0 WHERE id IN
      (SELECT id FROM checklist_items WHERE cleaning_id = ? ORDER BY position DESC LIMIT ?)`, c.id, missed);
    run(`UPDATE cleanings SET status = 'done', cleaner_id = ?, started_at = ?, finished_at = ?, comment = ?,
         inspection = 'ok', inspection_at = ?, rating = ? WHERE id = ?`,
      who, `${c.date} ${start}:00`, `${c.date} ${end}:00`, comment, `${c.date} ${start}:00`, rating, c.id);
  };

  // прошлые уборки — для истории и выплат
  const paidA = createCleaning({ date: d(-12), start_time: '11:00', cleaner_id: anna });
  finish(paidA, anna, { comment: 'Всё чисто.', rating: 5 });
  const paidM = createCleaning({ date: d(-10), start_time: '12:00', cleaner_id: maria });
  finish(paidM, maria, { start: '12:40', end: '14:30', rating: 4 });
  const payout = Number(run('INSERT INTO payouts(cleaner_id, amount, cleanings_sum, purchases_sum, created_at) VALUES(?,?,?,?,?)',
    anna, 900, 900, 0, `${d(-9)} 19:00:00`).lastInsertRowid);
  run('UPDATE cleanings SET payout_id = ? WHERE id = ?', payout, paidA.id);

  finish(createCleaning({ date: d(-6), start_time: '11:00', end_time: '14:00', cleaner_id: anna }), anna,
    { comment: 'В ванной слабо держится крючок для полотенца.', end: '12:50', rating: 5 });
  finish(createCleaning({ date: d(-4), start_time: '11:00', cleaner_id: maria }), maria, { missed: 2, comment: 'Не успела проветрить — гости заезжали раньше.', start: '11:35', end: '13:05', rating: 3 });
  finish(createCleaning({ date: d(-2), start_time: '12:00', type: 'general', cleaner_id: anna }), anna, { comment: 'Помыла окна и духовку.' });

  // сегодня — идёт уборка
  const now = createCleaning({ date: today(), start_time: '11:00', end_time: '14:00', cleaner_id: anna, note: 'Заезд в 14:00 — гости с ребёнком, поставить детскую кроватку' });
  run("UPDATE cleanings SET status = 'in_progress', started_at = ?, inspection = 'ok', inspection_at = ? WHERE id = ?", nowStr(), nowStr(), now.id);
  run('UPDATE checklist_items SET done = 1 WHERE cleaning_id = ? AND position < 9', now.id);

  // будущие
  const acc = createCleaning({ date: d(2), start_time: '11:00', cleaner_id: maria });
  run("UPDATE cleanings SET status = 'accepted' WHERE id = ?", acc.id);
  createCleaning({ date: d(3), start_time: '12:00', end_time: '15:00', cleaner_id: anna });
  const decl = createCleaning({ date: d(5), start_time: '11:00', cleaner_id: maria });
  run("UPDATE cleanings SET status = 'declined', decline_reason = 'Уезжаю к родителям' WHERE id = ?", decl.id);
  run('INSERT INTO declines(cleaning_id, user_id) VALUES(?, ?)', decl.id, maria);
  for (const n of [5, 6]) run('INSERT INTO unavailability(user_id, date) VALUES(?, ?)', maria, d(n));
  run('INSERT INTO unavailability(user_id, date) VALUES(?, ?)', anna, d(9));
  createCleaning({ date: d(7), start_time: '11:00', end_time: '14:00', source: 'ical', note: 'В этот же день заезд новых гостей — уборка срочная' });
  createCleaning({ date: d(10), start_time: '11:00', type: 'general', cleaner_id: anna });

  // проживания гостей между уборками: заезд в 14:00, выезд в 11:00 в день уборки
  const days = [-12, -10, -6, -4, -2, 0, 2, 3, 5, 7, 10];
  for (let i = 1; i < days.length; i++) {
    run("INSERT INTO stays(checkin, checkout, source) VALUES(?, ?, 'ical')", `${d(days[i - 1])} 14:00`, `${d(days[i])} 11:00`);
  }

  run('INSERT INTO purchases(title, note, created_by) VALUES(?,?,?)', 'Средство для стёкол', '2 шт', anna);
  run('INSERT INTO purchases(title, created_by) VALUES(?,?)', 'Мусорные пакеты', maria);
  run('INSERT INTO purchases(title, note, created_by) VALUES(?,?,?)', 'Капсулы для кофемашины', 'Nespresso', chief);
  run("INSERT INTO purchases(title, created_by, status, bought_by, bought_at, amount) VALUES(?,?,?,?,?,?)", 'Туалетная бумага', anna, 'bought', anna, nowStr(), 450);

  run('INSERT INTO problems(kind, description, created_by, cleaning_id) VALUES(?,?,?,?)', 'breakage', 'Не работает одна конфорка на плите (левая дальняя)', maria, paidM.id);
  run('INSERT INTO problems(kind, description, created_by) VALUES(?,?,?)', 'forgotten', 'Гости забыли зарядку от телефона. Положила в верхний ящик комода.', anna);

  run('INSERT INTO notifications(user_id, title, body, link) VALUES(?,?,?,?)', chief, 'Мария отказалась от уборки', 'Уезжаю к родителям. Назначьте другую уборщицу.', `#/cleaning/${decl.id}`);
  run('INSERT INTO notifications(user_id, title, body, link) VALUES(?,?,?,?)', anna, 'Новая уборка', 'Обычная уборка через 3 дня', '#/');

  setSetting('apartment', {
    name: 'Демо-квартира', address: 'ул. Примерная, 1, кв. 1 · 2 подъезд, 5 этаж',
    info: 'Wi‑Fi: DemoFlat / пароль 12345678\nБельё и полотенца: шкаф в коридоре\nМусор: контейнеры во дворе',
    access: 'Ключница слева от двери, код 0000. Верните ключ в ключницу после уборки.',
  });
  return { chief, anna };
}

function destroy(token) {
  const s = sandboxes.get(token);
  if (!s) return;
  sandboxes.delete(token);
  try { s.db.close(); } catch {}
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

export function createSandbox() {
  if (sandboxes.size >= MAX_SANDBOXES) {
    const oldest = [...sandboxes.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    destroy(oldest[0]);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const ids = withDb(db, seedDemoData);
  const dir = path.join(UPLOAD_DIR, `demo-${token.slice(0, 16)}`);
  fs.mkdirSync(dir, { recursive: true });
  sandboxes.set(token, { db, dir, chiefId: ids.chief, cleanerId: ids.anna, userId: ids.chief, lastSeen: Date.now() });
  return token;
}

export function getSandbox(token) {
  const s = token && sandboxes.get(token);
  if (s) s.lastSeen = Date.now();
  return s || null;
}

export const destroySandbox = destroy;

// уборка: просроченные песочницы и папки, оставшиеся после перезапуска
setInterval(() => {
  for (const [t, s] of sandboxes) if (Date.now() - s.lastSeen > IDLE_MS) destroy(t);
}, 10 * 60 * 1000).unref();
for (const name of fs.readdirSync(UPLOAD_DIR)) {
  if (name.startsWith('demo-')) fs.rm(path.join(UPLOAD_DIR, name), { recursive: true, force: true }, () => {});
}
