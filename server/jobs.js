// Фоновые задачи: синхронизация броней, напоминания, удаление старых видео.
import fs from 'node:fs';
import path from 'node:path';
import { all, run, getSetting, ymd, UPLOAD_DIR } from './db.js';
import { syncIcal } from './ical.js';
import { notify } from './notify.js';
import { describe, TYPE_LABEL } from './cleanings.js';

const MIN = 60_000;

function safe(name, fn) {
  return async () => {
    try { await fn(); } catch (e) { console.error(`[${name}]`, e); }
  };
}

// Вечером накануне напоминаем уборщице о завтрашней уборке
function remindTomorrow() {
  if (new Date().getHours() < 18) return;
  const tomorrow = ymd(new Date(Date.now() + 24 * 60 * MIN));
  const rows = all(`SELECT * FROM cleanings WHERE date = ? AND reminded = 0 AND cleaner_id IS NOT NULL
                    AND status IN ('assigned','accepted')`, tomorrow);
  for (const c of rows) {
    const extra = c.status === 'assigned' ? ' Подтвердите, что придёте.' : '';
    notify(c.cleaner_id, 'Завтра уборка', `${TYPE_LABEL[c.type]} · ${describe(c)}.${extra}`, `#/cleaning/${c.id}`);
    run('UPDATE cleanings SET reminded = 1 WHERE id = ?', c.id);
  }
}

// Видео удаляются через N дней (настройка), отчёт и чек-лист остаются
function expireVideos() {
  const days = +getSetting('video_retention_days') || 0;
  if (days <= 0) return;
  const rows = all(`SELECT id, filename FROM media WHERE kind = 'video' AND expired = 0
                    AND created_at < datetime('now', 'localtime', ?)`, `-${days} days`);
  for (const m of rows) {
    fs.rm(path.join(UPLOAD_DIR, m.filename), { force: true }, () => {});
    run('UPDATE media SET expired = 1 WHERE id = ?', m.id);
  }
  if (rows.length) console.log(`Удалено старых видео: ${rows.length}`);
}

export function startJobs() {
  const ical = safe('ical', syncIcal);
  const remind = safe('remind', remindTomorrow);
  const expire = safe('expire', expireVideos);
  setTimeout(ical, 5000);
  setInterval(ical, 30 * MIN);
  setInterval(remind, 10 * MIN);
  setInterval(expire, 60 * MIN);
  expire();
}
