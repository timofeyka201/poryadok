import {
  h, icon, api, post, isChief, section, row, money, shortDate, TYPE, emptyState, act, confirmAction, plural, avatar, MONTHS_NOM, todayYmd,
} from '../core.js';
import { refresh } from '../app.js';

export async function moneyView() {
  const data = await api('/money');
  const monthName = MONTHS_NOM[+todayYmd().slice(5, 7) - 1];
  return isChief() ? chiefMoney(data, monthName) : cleanerMoney(data, monthName);
}

function breakdown(b) {
  return h('div.group',
    b.cleanings.map((c) => row({ icon: 'sparkles', title: `${TYPE[c.type]} уборка`, sub: shortDate(c.date), value: money(c.pay_amount), onclick: () => (location.hash = `#/cleaning/${c.id}`) })),
    b.purchases.map((p) => row({ icon: 'cart', iconBg: 'var(--orange)', title: p.title, sub: `покупка · ${shortDate(p.bought_at)}`, value: money(p.amount) })));
}

function cleanerMoney({ people, payouts }, monthName) {
  const me = people[0];
  const b = me.balance;
  return {
    title: 'Заработок',
    content: [
      h('div.card',
        h('div.small.muted', 'К выплате'),
        h('div.amount', money(b.total)),
        h('div', { style: { marginTop: '12px' } },
          h('div.kv', h('span.k', `Уборки · ${b.cleanings.length}`), h('span.v', money(b.cleanings_sum))),
          h('div.kv', h('span.k', 'Компенсация покупок'), h('span.v', money(b.purchases_sum))))),
      h('div.card',
        h('div.small.muted', `${monthName}: завершено`),
        h('div', { style: { fontSize: '22px', fontWeight: 700, marginTop: '2px' } },
          `${me.month.count} ${plural(me.month.count, 'уборка', 'уборки', 'уборок')} · ${money(me.month.earned)}`)),
      b.total > 0 && section('Ещё не выплачено', null, breakdown(b)),
      section('Выплаты', null, payouts.length
        ? h('div.group', payouts.map((p) => row({
          icon: 'wallet', iconBg: 'var(--green)', title: money(p.amount), sub: `${shortDate(p.created_at)} · уборки ${money(p.cleanings_sum)}${p.purchases_sum ? `, покупки ${money(p.purchases_sum)}` : ''}`,
        })))
        : h('div.card', emptyState('wallet', 'Выплат пока не было'))),
    ],
  };
}

function chiefMoney({ people, payouts }, monthName) {
  const total = people.reduce((s, p) => s + p.balance.total, 0);
  return {
    title: 'Выплаты',
    back: '#/more',
    subtitle: `Всего к выплате: ${money(total)}`,
    content: [
      people.length === 0 && h('div.card', emptyState('users', 'Добавьте уборщиц в разделе «Команда»')),
      people.map((p) => {
        const b = p.balance;
        const details = h('div.hidden', { style: { marginTop: '14px' } }, breakdown(b));
        return h('div.card',
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            avatar(p),
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: 600 } }, p.name),
              h('div.small.muted', `${monthName}: ${p.month.count} ${plural(p.month.count, 'уборка', 'уборки', 'уборок')} · ${money(p.month.earned)}`)),
            h('div', { style: { textAlign: 'right' } }, h('div', { style: { fontSize: '22px', fontWeight: 700 } }, money(b.total)), h('div.small.muted', 'к выплате'))),
          b.total > 0 && h('div', { style: { marginTop: '12px' } },
            h('div.kv', h('span.k', `Уборки · ${b.cleanings.length}`), h('span.v', money(b.cleanings_sum))),
            h('div.kv', h('span.k', `Покупки · ${b.purchases.length}`), h('span.v', money(b.purchases_sum)))),
          details,
          b.total > 0 && h('div.btn-row', { style: { marginTop: '14px' } },
            h('button.btn.plain', { onclick: (e) => { details.classList.toggle('hidden'); e.currentTarget.textContent = details.classList.contains('hidden') ? 'Подробнее' : 'Скрыть'; } }, 'Подробнее'),
            h('button.btn.primary', {
              onclick: async (e) => {
                const btn = e.currentTarget;
                if (!(await confirmAction(`Выплатить ${money(b.total)}?`, 'Отметить как выплачено', { message: `${p.name} получит уведомление. Уборки и покупки будут отмечены оплаченными.` }))) return;
                await act(btn, () => post('/payouts', { cleaner_id: p.id }), 'Выплата отмечена');
                refresh();
              },
            }, 'Выплатить')));
      }),
      payouts.length > 0 && section('История', null, h('div.group', payouts.map((p) => row({
        icon: 'wallet', iconBg: 'var(--green)', title: `${p.name} · ${money(p.amount)}`,
        sub: `${shortDate(p.created_at)} · уборки ${money(p.cleanings_sum)}${p.purchases_sum ? `, покупки ${money(p.purchases_sum)}` : ''}`,
      })))),
    ],
  };
}
