import { all, get, run, getSetting } from './db.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const ruDate = (ymd) => {
  const [, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
export const describe = (c) => `${ruDate(c.date)}${c.start_time ? ', ' + c.start_time : ''}`;
export const TYPE_LABEL = { regular: 'Обычная уборка', general: 'Генеральная уборка' };

/** Копирует текущий шаблон чек-листа в новую уборку. */
export function fillChecklist(cleaningId, type) {
  run('DELETE FROM checklist_items WHERE cleaning_id = ?', cleaningId);
  const tpl = getSetting('templates')[type] || [];
  let pos = 0;
  for (const s of tpl) {
    for (const item of s.items) {
      // пункт шаблона — строка или { text, photo }
      const { text, photo } = typeof item === 'string' ? { text: item, photo: false } : item;
      run('INSERT INTO checklist_items(cleaning_id, section, text, position, photo_required) VALUES(?,?,?,?,?)',
        cleaningId, s.section, text, pos++, photo ? 1 : 0);
    }
  }
}

export function createCleaning({ date, start_time, end_time, type = 'regular', cleaner_id = null, note = null, pay_amount, source = 'manual', next_checkin = null }) {
  const rates = getSetting('rates');
  const status = cleaner_id ? 'assigned' : 'unassigned';
  const r = run(
    `INSERT INTO cleanings(date, start_time, end_time, type, cleaner_id, status, note, pay_amount, source, next_checkin)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    date, start_time || null, end_time || null, type, cleaner_id || null, status, note || null,
    Number.isFinite(+pay_amount) && pay_amount !== '' && pay_amount != null ? Math.round(+pay_amount) : rates[type] || 0,
    source, next_checkin);
  const id = Number(r.lastInsertRowid);
  fillChecklist(id, type);
  return get('SELECT * FROM cleanings WHERE id = ?', id);
}

// Synchronize open cleanings without losing unchanged items or their photos.
export function syncOpenChecklists() {
  const templates = getSetting('templates');
  for (const c of all("SELECT id, type FROM cleanings WHERE status IN ('unassigned','assigned','accepted','declined','in_progress')")) {
    const remaining = all('SELECT * FROM checklist_items WHERE cleaning_id = ? ORDER BY position, id', c.id);
    let position = 0;
    for (const section of templates[c.type] || []) {
      for (const entry of section.items) {
        const item = typeof entry === 'string' ? { text: entry, photo: false } : entry;
        const index = remaining.findIndex(old => old.section === section.section && old.text === item.text);
        if (index === -1) {
          run('INSERT INTO checklist_items(cleaning_id, section, text, position, photo_required) VALUES(?,?,?,?,?)',
            c.id, section.section, item.text, position++, item.photo ? 1 : 0);
        } else {
          const [old] = remaining.splice(index, 1);
          const hasPhoto = get("SELECT id FROM media WHERE item_id = ? AND owner_type = 'cleaning' AND owner_id = ? AND kind = 'photo' AND expired = 0", old.id, c.id);
          const done = old.done && (!item.photo || hasPhoto) ? 1 : 0;
          run('UPDATE checklist_items SET position = ?, photo_required = ?, done = ?, done_at = ? WHERE id = ?',
            position++, item.photo ? 1 : 0, done, done ? old.done_at : null, old.id);
        }
      }
    }
    for (const old of remaining) {
      run('UPDATE media SET item_id = NULL WHERE item_id = ?', old.id);
      run('DELETE FROM checklist_items WHERE id = ?', old.id);
    }
  }
}
