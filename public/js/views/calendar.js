import {
  h, icon, api, clear, isChief, section, emptyState, fullDate, ymd, todayYmd, MONTHS_NOM, plural,
} from '../core.js';
import { cleaningRow, cleaningEditor } from './shared.js';

const cal = { month: null, selected: null }; // запоминаем, где был пользователь

export async function calendarView() {
  if (!cal.selected) cal.selected = todayYmd();
  if (!cal.month) cal.month = cal.selected.slice(0, 7);

  const wrap = h('div');
  const dayList = h('div', { style: { marginTop: '24px' } });
  let items = [];
  let unavail = []; // отметки «не могу»: у уборщицы — свои, у шефа — всех

  const gridRange = () => {
    const [y, m] = cal.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // с понедельника
    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    // убираем последнюю неделю, если она целиком из следующего месяца
    if (days[35].getMonth() !== m - 1) days.length = 35;
    return days;
  };

  async function load() {
    const days = gridRange();
    [items, unavail] = await Promise.all([
      api(`/cleanings?from=${ymd(days[0])}&to=${ymd(days[days.length - 1])}`),
      api(`/unavailability?from=${ymd(days[0])}&to=${ymd(days[days.length - 1])}`),
    ]);
    draw();
  }

  function shiftMonth(delta) {
    const [y, m] = cal.month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    cal.month = ymd(d).slice(0, 7);
    load();
  }

  function draw() {
    const [y, m] = cal.month.split('-').map(Number);
    const t = todayYmd();
    const byDay = {};
    for (const c of items) (byDay[c.date] ||= []).push(c);

    const grid = h('div.cal-grid',
      ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => h('div.cal-wd', d)),
      gridRange().map((d) => {
        const key = ymd(d);
        const list = (byDay[key] || []).filter((c) => c.status !== 'cancelled');
        const cls = [
          d.getMonth() !== m - 1 && 'other', key === t && 'today', key === cal.selected && 'sel', [0, 6].includes(d.getDay()) && 'weekend',
          !isChief() && unavail.some((x) => x.date === key) && 'off',
        ].filter(Boolean).join(' ');
        return h('button.cal-day', { class: cls, onclick: () => { cal.selected = key; if (d.getMonth() !== m - 1) { cal.month = key.slice(0, 7); load(); } else draw(); } },
          h('span.n', d.getDate()),
          h('span.cal-dots', list.slice(0, 3).map((c) => h('i', { style: { background: dotColor(c) } }))));
      }));

    clear(wrap,
      h('div.card', { style: { padding: '14px 10px 6px' } },
        h('div.cal-head',
          h('div.cal-month', MONTHS_NOM[m - 1], ' ', h('span', y)),
          h('div.cal-nav',
            h('button.icon-btn', { onclick: () => { cal.selected = t; cal.month = t.slice(0, 7); load(); }, style: { width: 'auto', padding: '0 10px', fontSize: '15px', borderRadius: '10px' } }, 'Сегодня'),
            h('button.icon-btn', { onclick: () => shiftMonth(-1), 'aria-label': 'Предыдущий месяц' }, icon('chevL')),
            h('button.icon-btn', { onclick: () => shiftMonth(1), 'aria-label': 'Следующий месяц' }, icon('chevR')))),
        grid),
      isChief() && legend());

    const dayItems = byDay[cal.selected] || [];
    const cantNames = isChief() ? unavail.filter((x) => x.date === cal.selected).map((x) => x.name) : [];
    clear(dayList, section(fullDate(cal.selected), dayItems.length ? h('span.small.muted', `${dayItems.length} ${plural(dayItems.length, 'уборка', 'уборки', 'уборок')}`) : null,
      dayItems.length
        ? h('div.group', dayItems.map((c) => cleaningRow(c)))
        : h('div.card', emptyState('calendar', 'В этот день уборок нет'),
          isChief() && h('button.btn.tinted.block', { onclick: addForDay }, icon('plus'), 'Добавить уборку')),
      cantNames.length > 0 && h('div.section-foot', { style: { margin: '10px 4px 0' } }, icon('ban'), ` Не могут в этот день: ${cantNames.join(', ')}`),
      !isChief() && h('button.btn.plain.block', { style: { marginTop: '14px' }, onclick: () => (location.hash = '#/availability') }, icon('ban'), 'Отметить дни, когда не могу')));
  }

  function legend() {
    const users = [...new Map(items.filter((c) => c.cleaner_id).map((c) => [c.cleaner_id, c])).values()];
    if (!users.length) return null;
    return h('div.meta', { style: { margin: '12px 6px 0', gap: '14px' } },
      users.map((c) => h('span.small.muted', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span.dot', { style: { background: c.cleaner_color } }), c.cleaner_name)),
      h('span.small.muted', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span.dot', { style: { background: '#C7C7CC' } }), 'не назначена'));
  }

  const addForDay = () => cleaningEditor({ date: cal.selected }).then((id) => id && load());

  await load();
  return {
    title: 'Календарь',
    actions: isChief() ? [h('button.icon-btn', { onclick: addForDay, 'aria-label': 'Новая уборка' }, icon('plus'))] : [],
    content: [wrap, dayList],
  };
}

function dotColor(c) {
  if (c.status === 'declined') return 'var(--red)';
  if (!isChief()) return c.status === 'done' ? 'var(--green)' : 'var(--accent)';
  return c.cleaner_color || '#C7C7CC';
}
