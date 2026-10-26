import {
  h, icon, api, state, clear, segmented, emptyState, money, plural, MONTHS_NOM, todayYmd, ymd,
} from '../core.js';
import { reportRow } from './shared.js';

const hist = { month: null, cleaner: 'all' }; // запоминаем выбор между переходами

export async function historyView() {
  if (!hist.month) hist.month = todayYmd().slice(0, 7);
  const body = h('div');
  const cleanerList = state.users.filter((u) => u.role === 'cleaner');

  async function load() {
    const [y, m] = hist.month.split('-').map(Number);
    const from = `${hist.month}-01`;
    const to = ymd(new Date(y, m, 0));
    let items = (await api(`/cleanings?from=${from}&to=${to}&status=done`)).reverse();
    if (hist.cleaner !== 'all') items = items.filter((c) => c.cleaner_id === hist.cleaner);

    const sum = items.reduce((s, c) => s + c.pay_amount, 0);
    const incomplete = items.filter((c) => c.done_items < c.total_items).length;
    const noVideo = items.filter((c) => !c.videos).length;
    const isCurrent = hist.month === todayYmd().slice(0, 7);

    clear(body,
      h('div.card', { style: { padding: '14px 10px 14px 18px' } },
        h('div.cal-head', { style: { marginBottom: items.length ? '12px' : 0 } },
          h('div.cal-month', MONTHS_NOM[m - 1], ' ', h('span', y)),
          h('div.cal-nav',
            h('button.icon-btn', { onclick: () => shift(-1), 'aria-label': 'Предыдущий месяц' }, icon('chevL')),
            h('button.icon-btn', { onclick: () => shift(1), disabled: isCurrent, style: isCurrent ? { opacity: 0.3 } : null, 'aria-label': 'Следующий месяц' }, icon('chevR')))),
        items.length > 0 && h('div', { style: { paddingRight: '8px' } },
          kv('Уборок', items.length),
          kv('К оплате уборщицам', money(sum)),
          kv('С неполным чек-листом', incomplete, incomplete ? 'var(--orange)' : null),
          kv('Без видео', noVideo))),
      h('div.section',
        items.length
          ? h('div.group', items.map((c) => reportRow(c, { showDate: true, showPay: true })))
          : h('div.card', emptyState('clock', 'В этом месяце завершённых уборок нет'))));
  }

  function shift(delta) {
    const [y, m] = hist.month.split('-').map(Number);
    hist.month = ymd(new Date(y, m - 1 + delta, 1)).slice(0, 7);
    load();
  }

  await load();
  return {
    title: 'История уборок',
    back: '#/more',
    large: true,
    subtitle: 'Завершённые уборки по месяцам',
    content: [
      cleanerList.length > 1 && segmented(
        [['all', 'Все'], ...cleanerList.map((u) => [u.id, u.name])],
        hist.cleaner,
        (v) => { hist.cleaner = v; load(); }),
      body,
    ],
  };
}

const kv = (k, v, color) => h('div.kv', h('span.k', k), h('span.v', { style: color ? { color } : null }, v));
