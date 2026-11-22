// Синхронизация бронирований с площадок (Авито, Суточно.ру, Airbnb, Booking…) по iCal-ссылке.
// После каждого выезда гостя создаётся уборка «Не назначена» — шефу остаётся выбрать уборщицу.
import { all, get, run, getSetting, setSetting, today, nowStr, tx, currentDb } from './db.js';
import { createCleaning, describe } from './cleanings.js';
import { notify, chiefIds } from './notify.js';

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseDate(value) {
  // 20261026  |  20261026T110000  |  20261026T080000Z
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  if (m[7]) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function parseIcal(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).split(';')[0].toUpperCase();
      const val = line.slice(i + 1).trim();
      if (key === 'UID') cur.uid = val;
      else if (key === 'DTSTART') cur.start = parseDate(val);
      else if (key === 'DTEND') cur.end = parseDate(val);
      else if (key === 'SUMMARY') cur.summary = val;
      else if (key === 'STATUS') cur.status = val.toUpperCase();
    }
  }
  return events.filter((e) => e.uid && e.start && e.end && e.status !== 'CANCELLED');
}

// Блокировки дат хозяином — не бронь, уборка после них не нужна
const isBlock = (e) => /not available|недоступ|blocked|закрыт/i.test(e.summary || '');

const pending = "('unassigned','assigned','accepted','declined')";
const syncing = new WeakMap();

export function syncIcal() {
  const db = currentDb();
  if (!syncing.has(db)) {
    syncing.set(db, syncFeeds().finally(() => syncing.delete(db)));
  }
  return syncing.get(db);
}

async function syncFeeds() {
  const feeds = getSetting('ical').filter((f) => f.url);
  if (!feeds.length) return { ok: true, created: 0, message: 'Ссылки не добавлены' };

  const events = [];
  const errors = [];
  for (const f of feeds) {
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const calendar = await res.text();
      const lines = unfold(calendar.trim());
      if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR') {
        throw new Error('Ответ не содержит календарь iCal');
      }
      for (const e of parseIcal(calendar)) {
        if (!isBlock(e)) events.push({ ...e, uid: `${f.name}:${e.uid}` });
      }
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }

  const t = today();
  const { checkout, checkin } = getSetting('times');
  const checkinDays = new Set(events.map((e) => e.start));
  const nextCheckin = (date) => events.map((e) => e.start).filter((d) => d >= date).sort()[0] || null;
  let created = 0;
  let cancelled = 0;

  tx(() => {
    const datesByUid = new Map(events.map((e) => [e.uid, e.end]));
    const linkedCleanings = new Set(all('SELECT DISTINCT cleaning_id FROM ical_links').map((link) => link.cleaning_id));
    const bookingsByDate = new Map();
    for (const e of events) {
      if (e.end < t) continue;
      const linked = get(`SELECT c.* FROM cleanings c JOIN ical_links l ON l.cleaning_id = c.id WHERE l.uid = ?`, e.uid);
      if (linked?.status === 'cancelled' && linked.cancelled_manually && linked.date === e.end) continue;
      if (!bookingsByDate.has(e.end)) bookingsByDate.set(e.end, []);
      bookingsByDate.get(e.end).push({ uid: e.uid, linked });
    }

    for (const [date, bookings] of bookingsByDate) {
      const sameDayCheckin = checkinDays.has(date);
      // Выезд может присутствовать в нескольких лентах. Учитываем только уборку на нужную дату.
      let c = get(`SELECT * FROM cleanings WHERE date = ?
        AND (status IN ('unassigned','assigned','accepted','declined','in_progress')
          OR (status = 'done' AND finished_at >= ?))
        ORDER BY CASE status WHEN 'done' THEN 2 WHEN 'unassigned' THEN 1 ELSE 0 END, id LIMIT 1`,
      date, `${date} ${checkout}`);

      if (!c) {
        // Переносим ещё не начатую уборку, если она не нужна для другого выезда.
        for (const { linked } of bookings) {
          if (!linked || linked.source !== 'ical') continue;
          const movable = get(`SELECT * FROM cleanings WHERE id = ? AND status IN ${pending}`, linked.id);
          if (!movable) continue;
          const aliases = all('SELECT uid FROM ical_links WHERE cleaning_id = ?', movable.id);
          if (aliases.some(({ uid }) => datesByUid.has(uid) ? datesByUid.get(uid) !== date : errors.length > 0)) continue;
          run('UPDATE cleanings SET date = ?, end_time = ?, next_checkin = ?, reminded = 0 WHERE id = ?',
            date, sameDayCheckin ? checkin : null, nextCheckin(date), movable.id);
          c = { ...movable, date };
          if (c.cleaner_id) notify(c.cleaner_id, 'Уборка перенесена', `Новая дата: ${describe(c)}`, `#/cleaning/${c.id}`);
          break;
        }
      }
      if (!c) {
        c = createCleaning({
          date, start_time: checkout, end_time: sameDayCheckin ? checkin : null,
          source: 'ical', next_checkin: nextCheckin(date),
          note: sameDayCheckin ? 'В этот же день заезд новых гостей — уборка срочная' : null,
        });
        created++;
      }
      for (const { uid } of bookings) {
        run(`INSERT INTO ical_links(uid, cleaning_id) VALUES(?, ?)
          ON CONFLICT(uid) DO UPDATE SET cleaning_id = excluded.cleaning_id`, uid, c.id);
      }
    }

    // отменённые брони: удаляем уборку, только если все ленты загрузились без ошибок
    if (!errors.length) {
      // проживания гостей пересобираем из актуальных броней (одна бронь с разных площадок — один раз)
      run("DELETE FROM stays WHERE source = 'ical' AND checkout >= ?", t);
      const seen = new Set();
      for (const e of events) {
        if (e.end < t || seen.has(e.start + e.end)) continue;
        seen.add(e.start + e.end);
        run("INSERT INTO stays(checkin, checkout, source) VALUES(?, ?, 'ical')", `${e.start} ${checkin}`, `${e.end} ${checkout}`);
      }

      const future = all(`SELECT * FROM cleanings WHERE source = 'ical' AND date >= ?
                          AND status IN ${pending}`, t);
      for (const c of future) {
        const uids = all('SELECT uid FROM ical_links WHERE cleaning_id = ?', c.id).map((r) => r.uid);
        if (linkedCleanings.has(c.id) && !uids.some((u) => datesByUid.get(u) === c.date)) {
          run("UPDATE cleanings SET status = 'cancelled', cancelled_manually = 0 WHERE id = ?", c.id);
          if (c.cleaner_id) notify(c.cleaner_id, 'Уборка отменена', `${describe(c)} — бронь отменили`, `#/cleaning/${c.id}`);
          cancelled++;
        }
      }
    }
  });

  if (created) notify(chiefIds(), 'Новые уборки из бронирований', `Добавлено: ${created}. Назначьте уборщиц.`, '#/calendar');
  const message = errors.length ? `Ошибки: ${errors.join('; ')}` : `Готово. Новых уборок: ${created}, отменено: ${cancelled}`;
  const status = { at: nowStr(), ok: !errors.length, message };
  setSetting('ical_status', status);
  return status;
}
