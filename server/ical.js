// Синхронизация бронирований с площадок (Авито, Суточно.ру, Airbnb, Booking…) по iCal-ссылке.
// После каждого выезда гостя создаётся уборка «Не назначена» — шефу остаётся выбрать уборщицу.
import { createHash } from 'node:crypto';
import { all, run, getSetting, setSetting, today, nowStr, tx, currentDb, ymd } from './db.js';
import { createCleaning, describe } from './cleanings.js';
import { notify, chiefIds } from './notify.js';

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseDate(value) {
  // 20261026  |  20261026T110000  |  20261026T080000Z
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = m[4] ? `${m[4]}:${m[5]}:${m[6]}` : '00:00:00';
  const parsed = new Date(`${date}T${time}Z`);
  if (Number.isNaN(+parsed) || parsed.toISOString().slice(0, 19) !== `${date}T${time}`) return null;
  return m[7] ? ymd(parsed) : date;
}

// Блокировки дат хозяином — не бронь, уборка после них не нужна.
const isBlock = (e) => /not available|недоступ|blocked|закрыт/i.test(e.summary || '');

export function parseIcal(text) {
  const lines = unfold(text.trim());
  if (lines[0]?.toUpperCase() !== 'BEGIN:VCALENDAR' || lines.at(-1)?.toUpperCase() !== 'END:VCALENDAR') {
    throw new Error('Ответ не содержит календарь iCal');
  }
  const events = new Map();
  let cur = null;
  let depth = 0;
  for (const line of lines.slice(1, -1)) {
    const marker = line.toUpperCase();
    if (marker === 'BEGIN:VEVENT') {
      if (cur) throw new Error('Незакрытая запись в календаре');
      cur = { sequence: 0 };
    } else if (marker === 'END:VEVENT') {
      if (!cur || depth) throw new Error('Повреждённая запись в календаре');
      cur.cancelled = cur.status === 'CANCELLED' || isBlock(cur);
      if (!cur.uid || (!cur.cancelled && (!cur.start || !cur.end || cur.end < cur.start))) {
        throw new Error('В календаре есть бронь без корректных дат или идентификатора');
      }
      const previous = events.get(cur.uid);
      if (previous?.sequence === cur.sequence && (previous.cancelled !== cur.cancelled
        || (!cur.cancelled && (previous.start !== cur.start || previous.end !== cur.end)))) {
        throw new Error('Календарь содержит противоречивые версии брони');
      }
      if (!previous || cur.sequence > previous.sequence) events.set(cur.uid, cur);
      cur = null;
    } else if (cur) {
      if (marker.startsWith('BEGIN:')) { depth++; continue; }
      if (marker.startsWith('END:')) { depth--; continue; }
      if (depth) continue;
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).split(';')[0].toUpperCase();
      const val = line.slice(i + 1).trim();
      if (key === 'UID') cur.uid = val;
      else if (key === 'DTSTART') cur.start = parseDate(val);
      else if (key === 'DTEND') cur.end = parseDate(val);
      else if (key === 'SUMMARY') cur.summary = val;
      else if (key === 'STATUS') cur.status = val.toUpperCase();
      else if (key === 'SEQUENCE' && /^\d+$/.test(val)) cur.sequence = Number(val);
    }
  }
  if (cur) throw new Error('Незакрытая запись в календаре');
  return [...events.values()].filter((e) => !e.cancelled);
}

const pending = new Set(['unassigned', 'assigned', 'accepted', 'declined']);
const running = new WeakMap();
const reportDay = (c) => (c.started_at || c.finished_at || c.date).slice(0, 10);
const stayKey = (e) => `${e.start}/${e.end}`;

function saveStatus(ok, message) {
  const status = { at: nowStr(), ok, message };
  setSetting('ical_status', status);
  return status;
}

export function syncIcal() {
  const db = currentDb();
  if (!running.has(db)) running.set(db, syncFeeds().finally(() => running.delete(db)));
  return running.get(db);
}

async function syncFeeds() {
  const settings = getSetting('ical');
  const feeds = [...new Map(settings.filter((f) => f.url).map((f) => [f.url, f])).values()];
  const results = await Promise.allSettled(feeds.map(async (f) => {
    const res = await fetch(f.url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feedId = createHash('sha256').update(f.url).digest('hex');
    return parseIcal(await res.text()).map((e) => ({
      ...e, uid: `feed:${feedId}:${e.uid}`, legacyUid: `${f.name}:${e.uid}`,
    }));
  }));
  if (JSON.stringify(settings) !== JSON.stringify(getSetting('ical'))) {
    return saveStatus(false, 'Список календарей изменился во время загрузки. Повторите синхронизацию.');
  }
  const errors = results.flatMap((r, i) => r.status === 'rejected' ? [`${feeds[i].name}: ${r.reason.message}`] : []);
  if (errors.length) return saveStatus(false, `Календарь не изменён. Ошибки: ${errors.join('; ')}`);

  const events = results.flatMap((r) => r.value);
  const { checkout, checkin } = getSetting('times');
  const day = today();
  const notices = [];
  const status = tx(() => {
    const { created, cancelled } = updateCleanings(events, day, checkout, notices);
    run("DELETE FROM stays WHERE source = 'ical' AND checkout >= ?", day);
    const seen = new Set();
    for (const e of events) {
      if (e.end < day || seen.has(stayKey(e))) continue;
      seen.add(stayKey(e));
      run("INSERT INTO stays(checkin, checkout, source) VALUES(?, ?, 'ical')", `${e.start} ${checkin}`, `${e.end} ${checkout}`);
    }
    if (created) notices.push([chiefIds(), 'Новые уборки из бронирований', `Добавлено: ${created}. Назначьте уборщиц.`, '#/calendar']);
    const message = `Новых уборок: ${created}, отменено: ${cancelled}`;
    return saveStatus(true, feeds.length ? `Готово. ${message}` : `Ссылки не добавлены. ${message}`);
  });
  for (const args of notices) notify(...args);
  return status;
}

function updateCleanings(events, day, checkout, notices) {
  const rows = all('SELECT * FROM cleanings ORDER BY id');
  const byId = new Map(rows.map((c) => [c.id, c]));
  const links = new Map(all('SELECT uid, cleaning_id FROM ical_links').map((link) => [link.uid, link.cleaning_id]));
  const previouslyLinked = new Set(links.values());
  const legacyCount = new Map();
  for (const e of events) legacyCount.set(e.legacyUid, (legacyCount.get(e.legacyUid) || 0) + 1);

  const groups = new Map();
  const datesForCleaning = new Map();
  const manuallyCancelled = new Map();
  const current = events.filter((e) => e.end >= day).map((e) => {
    const legacy = legacyCount.get(e.legacyUid) === 1 && links.has(e.legacyUid);
    const cleaning = byId.get(links.get(e.uid) ?? (legacy ? links.get(e.legacyUid) : null));
    if (cleaning?.status === 'cancelled' && cleaning.cancelled_manually && cleaning.date === e.end) {
      manuallyCancelled.set(stayKey(e), cleaning);
    }
    return { ...e, legacy, cleaning };
  });
  const bind = (e, c) => {
    run(`INSERT INTO ical_links(uid, cleaning_id) VALUES(?, ?)
      ON CONFLICT(uid) DO UPDATE SET cleaning_id = excluded.cleaning_id`, e.uid, c.id);
    if (e.legacy) run('DELETE FROM ical_links WHERE uid = ?', e.legacyUid);
  };

  for (const e of current) {
    const cancelled = manuallyCancelled.get(stayKey(e));
    if (cancelled) { bind(e, cancelled); continue; }
    if (!groups.has(e.end)) groups.set(e.end, []);
    groups.get(e.end).push(e);
    if (e.cleaning) {
      if (!datesForCleaning.has(e.cleaning.id)) datesForCleaning.set(e.cleaning.id, new Set());
      datesForCleaning.get(e.cleaning.id).add(e.end);
    }
  }

  // Сначала резервируем подходящие уборки на прежних датах, затем переносим остальные.
  // Так один перенесённый дубль не заберёт уборку у выезда, оставшегося на этой дате.
  const matches = new Map();
  const used = new Set();
  for (const [date, group] of groups) {
    const linked = new Set(group.map((e) => e.cleaning?.id));
    const open = rows.filter((c) => c.date === date && (pending.has(c.status) || c.status === 'in_progress'));
    const c = open.find((c) => c.status === 'in_progress')
      || open.find((c) => linked.has(c.id) && c.cleaner_id)
      || open.find((c) => c.cleaner_id) || open[0]
      || rows.find((c) => c.status === 'done' && reportDay(c) === date
        && (linked.has(c.id) || c.finished_at >= `${date} ${checkout}`));
    if (c) { matches.set(date, c); used.add(c.id); }
  }

  let created = 0;
  let cancelled = 0;
  for (const [date, group] of groups) {
    let c = matches.get(date);
    if (!c) {
      c = group.map((e) => e.cleaning).find((c) => c?.source === 'ical' && pending.has(c.status)
        && !used.has(c.id) && datesForCleaning.get(c.id).size === 1);
      if (c) {
        run('UPDATE cleanings SET date = ?, reminded = 0 WHERE id = ?', date, c.id);
        if (c.cleaner_id) notices.push([c.cleaner_id, 'Уборка перенесена', `Новая дата: ${describe({ ...c, date })}`, `#/cleaning/${c.id}`]);
      } else {
        c = createCleaning({ date, start_time: checkout, source: 'ical' });
        created++;
      }
    }
    used.add(c.id);
    for (const e of group) bind(e, c);
  }

  for (const c of rows) {
    if (c.source !== 'ical' || c.date < day || !pending.has(c.status) || !previouslyLinked.has(c.id) || used.has(c.id)) continue;
    run("UPDATE cleanings SET status = 'cancelled', cancelled_manually = 0 WHERE id = ?", c.id);
    if (c.cleaner_id) notices.push([c.cleaner_id, 'Уборка отменена', `${describe(c)} — выезд больше не запланирован`, `#/cleaning/${c.id}`]);
    cancelled++;
  }
  return { created, cancelled };
}
