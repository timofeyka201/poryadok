// Синхронизация бронирований с площадок (Авито, Суточно.ру, Airbnb, Booking…) по iCal-ссылке.
// После каждого выезда гостя создаётся уборка «Не назначена» — шефу остаётся выбрать уборщицу.
import { all, get, run, getSetting, setSetting, today, nowStr, tx } from './db.js';
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

export async function syncIcal() {
  const feeds = getSetting('ical').filter((f) => f.url);
  if (!feeds.length) return { ok: true, created: 0, message: 'Ссылки не добавлены' };

  const events = [];
  const errors = [];
  for (const f of feeds) {
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const e of parseIcal(await res.text())) {
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
    for (const e of events) {
      if (e.end < t) continue;
      const link = get('SELECT cleaning_id FROM ical_links WHERE uid = ?', e.uid);
      const sameDayCheckin = checkinDays.has(e.end);
      if (link) {
        // бронь могли перенести — двигаем уборку, если её ещё не начали
        const c = get('SELECT * FROM cleanings WHERE id = ?', link.cleaning_id);
        if (c && c.date !== e.end && ['unassigned', 'assigned', 'accepted', 'declined'].includes(c.status)) {
          run('UPDATE cleanings SET date = ?, end_time = ?, next_checkin = ? WHERE id = ?',
            e.end, sameDayCheckin ? checkin : null, nextCheckin(e.end), c.id);
          if (c.cleaner_id) notify(c.cleaner_id, 'Уборка перенесена', `Новая дата: ${describe({ ...c, date: e.end })}`, `#/cleaning/${c.id}`);
        }
        continue;
      }
      // одна и та же бронь может прийти с нескольких площадок — не дублируем уборку
      let c = get("SELECT * FROM cleanings WHERE date = ? AND status != 'cancelled' ORDER BY id LIMIT 1", e.end);
      if (!c) {
        c = createCleaning({
          date: e.end, start_time: checkout, end_time: sameDayCheckin ? checkin : null,
          source: 'ical', next_checkin: nextCheckin(e.end),
          note: sameDayCheckin ? 'В этот же день заезд новых гостей — уборка срочная' : null,
        });
        created++;
      }
      run('INSERT OR IGNORE INTO ical_links(uid, cleaning_id) VALUES(?, ?)', e.uid, c.id);
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

      const present = new Set(events.map((e) => e.uid));
      const future = all(`SELECT * FROM cleanings WHERE source = 'ical' AND date >= ?
                          AND status IN ('unassigned','assigned','accepted','declined')`, t);
      for (const c of future) {
        const uids = all('SELECT uid FROM ical_links WHERE cleaning_id = ?', c.id).map((r) => r.uid);
        if (uids.length && !uids.some((u) => present.has(u))) {
          run("UPDATE cleanings SET status = 'cancelled' WHERE id = ?", c.id);
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
