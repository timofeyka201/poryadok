import {
  h, icon, api, post, state, isChief, clear, segmented, emptyState, ago, money, shortDate, act, actionSheet, toast,
} from '../core.js';
import { boughtSheet } from './shared.js';
import { refreshSummary } from '../app.js';

let tab = 'needed';

export async function purchasesView() {
  const listEl = h('div');

  async function load() {
    const items = await api(`/purchases?status=${tab}`);
    clear(listEl, tab === 'needed' ? neededList(items) : boughtList(items));
  }

  // быстрый ввод, как в «Напоминаниях»
  const input = h('input.input', { placeholder: 'Что нужно докупить?', enterkeyhint: 'done' });
  const addBtn = h('button.btn.primary', { type: 'submit', 'aria-label': 'Добавить' }, icon('plus'));
  const addForm = h('form.add-inline', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      await act(addBtn, () => post('/purchases', { title: input.value }), 'Добавлено — все увидят');
      input.value = '';
      refreshSummary();
      if (tab === 'needed') load();
    },
  }, input, addBtn);

  function neededList(items) {
    if (!items.length) return h('div.card', emptyState('cart', 'Всё есть. Если что-то заканчивается — добавьте сюда, и другие увидят.'));
    return [
      h('div.group', items.map((p) => {
        const mineOrChief = isChief() || p.created_by === state.me.id;
        return h('div.row',
          h('button.check', { style: { padding: 0, width: 'auto', background: 'transparent' }, 'aria-label': 'Отметить купленным',
            onclick: () => boughtSheet(p).then((ok) => ok && load()) }, h('span.box', icon('check'))),
          h('div.row-main', { style: { cursor: 'pointer' }, onclick: () => menu(p, mineOrChief) },
            h('div.row-title', p.title),
            h('div.row-sub', `${p.note ? p.note + ' · ' : ''}${p.author}, ${ago(p.created_at)}`)));
      })),
      h('div.section-foot', 'Купили? Нажмите на кружок и укажите сумму — она добавится к выплате.'),
    ];
  }

  async function menu(p, canDelete) {
    const actions = [{ text: 'Отметить купленным', value: 'bought' }];
    if (canDelete) actions.push({ text: 'Удалить из списка', value: 'delete', destructive: true });
    const v = await actionSheet({ title: p.title, message: p.note, actions });
    if (v === 'bought') { if (await boughtSheet(p)) load(); }
    if (v === 'delete') { await act(null, () => api(`/purchases/${p.id}`, { method: 'DELETE' }), 'Удалено'); refreshSummary(); load(); }
  }

  function boughtList(items) {
    if (!items.length) return h('div.card', emptyState('cart', 'Здесь появятся купленные товары'));
    return h('div.group', items.map((p) => {
      const status = !p.amount ? null : p.payout_id ? h('span.pill.green', 'компенсировано') : h('span.pill.orange', 'к компенсации');
      const canRestore = !p.payout_id && (isChief() || p.bought_by === state.me.id);
      return h('div.row.has-icon',
        h('span.row-icon', { style: { background: 'var(--green)' } }, icon('check')),
        h('div.row-main',
          h('div.row-title', p.title),
          h('div.row-sub', `${p.buyer}, ${shortDate(p.bought_at)}${p.amount ? ' · ' + money(p.amount) : ''}`),
          (status || p.receipt_id) && h('div.meta', { style: { marginTop: '6px' } }, status,
            p.receipt_id && h('a.pill.gray', { href: `/media/${p.receipt_id}`, target: '_blank' }, icon('camera'), 'чек'))),
        canRestore && h('button.icon-btn', {
          'aria-label': 'Вернуть в список',
          onclick: async () => {
            const v = await actionSheet({ title: p.title, actions: [{ text: 'Вернуть в «Нужно купить»', value: 'restore' }] });
            if (v === 'restore') { await act(null, () => post(`/purchases/${p.id}/restore`), 'Возвращено в список'); refreshSummary(); load(); }
          },
        }, icon('more')));
    }));
  }

  await load();
  return {
    title: 'Покупки',
    subtitle: 'Общий список для всех уборщиц',
    content: [
      addForm,
      segmented([['needed', `Нужно купить${state.summary.purchases ? ' · ' + state.summary.purchases : ''}`], ['bought', 'Куплено']], tab, (v) => { tab = v; load(); }),
      listEl,
    ],
  };
}
