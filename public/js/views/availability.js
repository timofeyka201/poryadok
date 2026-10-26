import {
  h, icon, api, post, clear, toast, actionSheet, MONTHS_NOM, ymd, todayYmd, shortDate, emptyState,
} from '../core.js';

const av = { month: null };

/** Уборщица отмечает дни, когда не может убирать: шеф видит это при назначении, и замена предлагается автоматически. */
export async function availabilityView() {
  const t = todayYmd();
  if (!av.month) av.month = t.slice(0, 7);
  const wrap = h('div');
  const listEl = h('div');
  let off = new Set();
  let busy = new Set();

  const gridDays = () => {
    const [y, m] = av.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));
    const days = [];
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
    if (days[35].getMonth() !== m - 1) days.length = 35;
    return days;
  };

  async function load() {
    const days = gridDays();
    const from = ymd(days[0]);
    const to = ymd(days[days.length - 1]);
    const [un, mine, upcoming] = await Promise.all([
      api(`/unavailability?from=${from}&to=${to}`),
      api(`/cleanings?from=${from}&to=${to}&status=assigned,accepted,in_progress`),
      api(`/unavailability?from=${t}`),
    ]);
    off = new Set(un.map((x) => x.date));
    busy = new Set(mine.map((c) => c.date));
    draw();
    clear(listEl, upcoming.length
      ? h('div.card.small', h('b', 'Вы не можете: '), upcoming.map((x) => shortDate(x.date)).join(', '))
      : h('div.card', emptyState('calendar', 'Все дни свободны')));
  }

  async function toggle(date) {
    try {
      const r = await post('/unavailability/toggle', { date });
      if (r.conflict) {
        const v = await actionSheet({
          title: 'В этот день у вас уборка',
          message: 'Шеф не узнает, что вы не можете, пока вы не откажетесь от уборки',
          actions: [{ text: 'Открыть уборку и отказаться', value: 'open' }],
        });
        if (v === 'open') { location.hash = `#/cleaning/${r.conflict.id}`; return; }
      } else {
        toast(r.unavailable ? 'Отмечено: не можете' : 'Отметка снята');
      }
      load();
    } catch (e) { toast(e.message, true); }
  }

  function draw() {
    const [y, m] = av.month.split('-').map(Number);
    clear(wrap, h('div.card', { style: { padding: '14px 10px 6px' } },
      h('div.cal-head',
        h('div.cal-month', MONTHS_NOM[m - 1], ' ', h('span', y)),
        h('div.cal-nav',
          h('button.icon-btn', { onclick: () => shift(-1), 'aria-label': 'Предыдущий месяц', disabled: av.month <= t.slice(0, 7) }, icon('chevL')),
          h('button.icon-btn', { onclick: () => shift(1), 'aria-label': 'Следующий месяц' }, icon('chevR')))),
      h('div.cal-grid',
        ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => h('div.cal-wd', d)),
        gridDays().map((d) => {
          const key = ymd(d);
          const other = d.getMonth() !== m - 1;
          const cls = [other && 'other', key === t && 'today', off.has(key) && 'off'].filter(Boolean).join(' ');
          return h('button.cal-day', { class: cls, disabled: key < t || other, onclick: () => toggle(key) },
            h('span.n', d.getDate()),
            h('span.cal-dots', busy.has(key) && h('i', { style: { background: 'var(--accent)' } })));
        }))));
  }

  function shift(delta) {
    const [y, m] = av.month.split('-').map(Number);
    av.month = ymd(new Date(y, m - 1 + delta, 1)).slice(0, 7);
    load();
  }

  await load();
  return {
    title: 'Когда я не могу',
    back: '#/profile',
    large: true,
    subtitle: 'Нажмите на дни, когда не можете убирать. Шеф не будет назначать вас на них, а при отказе сервис сам предложит другую уборщицу.',
    content: [
      wrap,
      h('div.meta', { style: { margin: '12px 6px 0', gap: '14px' } },
        h('span.small.muted', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span.dot', { style: { background: 'var(--red)' } }), 'не могу'),
        h('span.small.muted', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span.dot', { style: { background: 'var(--accent)' } }), 'моя уборка')),
      h('div.section', listEl),
    ],
  };
}
