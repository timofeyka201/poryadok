import {
  h, icon, api, post, clear, toast, actionSheet, MONTHS_NOM, ymd, todayYmd, shortDate, emptyState, isChief, fullDate,
  section, avatar, addDays,
} from '../core.js';

const av = { month: null, selected: null };

const gridDaysFor = (month) => {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const days = [];
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
  if (days[35].getMonth() !== m - 1) days.length = 35;
  return days;
};

export const availabilityView = () => (isChief() ? chiefAvailabilityView() : cleanerAvailabilityView());

/** Шеф: кто из уборщиц в какие дни не может — месяц с отметками и список ближайших дат. */
async function chiefAvailabilityView() {
  const t = todayYmd();
  if (!av.month) av.month = t.slice(0, 7);
  if (!av.selected) av.selected = t;
  const wrap = h('div');
  const dayEl = h('div');
  const listEl = h('div');
  let marks = [];

  async function load() {
    const days = gridDaysFor(av.month);
    const [inMonth, upcoming] = await Promise.all([
      api(`/unavailability?from=${ymd(days[0])}&to=${ymd(days[days.length - 1])}`),
      api(`/unavailability?from=${t}&to=${addDays(t, 60)}`),
    ]);
    marks = inMonth;
    draw();
    // ближайшие 60 дней, сгруппировано по дате
    const byDate = new Map();
    for (const x of upcoming) (byDate.get(x.date) || byDate.set(x.date, []).get(x.date)).push(x);
    clear(listEl, section('Ближайшие 2 месяца', null, byDate.size
      ? h('div.group', [...byDate].map(([date, people]) => h('button.row', { onclick: () => { av.selected = date; av.month = date.slice(0, 7); load(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
        h('div.row-main', h('div.row-title', fullDate(date)),
          h('div.meta', { style: { marginTop: '4px' } }, people.map((p) => h('span.pill.gray', h('span.dot', { style: { background: p.color } }), p.name)))))))
      : h('div.card', emptyState('check', 'Все уборщицы могут работать в любой день'))));
  }

  function draw() {
    const [y, m] = av.month.split('-').map(Number);
    clear(wrap, h('div.card', { style: { padding: '14px 10px 6px' } },
      h('div.cal-head',
        h('div.cal-month', MONTHS_NOM[m - 1], ' ', h('span', y)),
        h('div.cal-nav',
          h('button.icon-btn', { onclick: () => shift(-1), 'aria-label': 'Предыдущий месяц' }, icon('chevL')),
          h('button.icon-btn', { onclick: () => shift(1), 'aria-label': 'Следующий месяц' }, icon('chevR')))),
      h('div.cal-grid',
        ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => h('div.cal-wd', d)),
        gridDaysFor(av.month).map((d) => {
          const key = ymd(d);
          const people = marks.filter((x) => x.date === key);
          const cls = [d.getMonth() !== m - 1 && 'other', key === t && 'today', key === av.selected && 'sel'].filter(Boolean).join(' ');
          return h('button.cal-day', { class: cls, onclick: () => { av.selected = key; draw(); } },
            h('span.n', d.getDate()),
            h('span.cal-dots', people.slice(0, 3).map((x) => h('i.ring', { style: { borderColor: x.color } }))));
        }))));
    const people = marks.filter((x) => x.date === av.selected);
    clear(dayEl, h('div.card', { style: { marginTop: '12px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, fullDate(av.selected)),
      people.length
        ? h('div.meta', h('span.small.muted', 'Не могут:'), people.map((p) => h('span.pill.red', p.name)))
        : h('div.small.muted', 'Все уборщицы могут')));
  }

  function shift(delta) {
    const [y, m] = av.month.split('-').map(Number);
    av.month = ymd(new Date(y, m - 1 + delta, 1)).slice(0, 7);
    load();
  }

  await load();
  return {
    title: 'Кто когда не может',
    back: '#/more',
    large: true,
    subtitle: 'Уборщицы отмечают это сами. Кольцо цвета уборщицы — в этот день она не может.',
    content: [wrap, dayEl, listEl],
  };
}

/** Уборщица отмечает дни, когда не может убирать: шеф видит это при назначении, и замена предлагается автоматически. */
async function cleanerAvailabilityView() {
  const t = todayYmd();
  if (!av.month) av.month = t.slice(0, 7);
  const wrap = h('div');
  const listEl = h('div');
  let off = new Set();
  let busy = new Set();

  const gridDays = () => gridDaysFor(av.month);

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
