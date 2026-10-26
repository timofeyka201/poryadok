import { get, run, getSetting } from './db.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const ruDate = (ymd) => {
  const [, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
export const describe = (c) => `${ruDate(c.date)}${c.start_time ? ', ' + c.start_time : ''}`;
export const TYPE_LABEL = { regular: 'Обычная уборка', general: 'Генеральная уборка' };

/** Копирует шаблон чек-листа в уборку — изменения шаблона потом не задевают старые уборки. */
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
