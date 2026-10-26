import {
  h, icon, api, post, state, isChief, section, row, statusPill, dayLabel, fullDate, timeRange, TYPE, money,
  emptyState, progressBar, todayYmd, addDays, act, plural, sheet, field, toast, clear, ago, timeOf, shortDate, STATUS,
  confirmAction,
} from '../core.js';
import { cleaningRow, reportRow, cleaningEditor, assignSheet, assignSuggested, accessBox, pushBanner, apartmentCard, problemSheet, addPurchaseSheet } from './shared.js';
import { refresh, refreshSummary } from '../app.js';

export async function homeView() {
  return isChief() ? chiefHome() : cleanerHome();
}

// =============== уборщица ===============
async function cleanerHome() {
  const t = todayYmd();
  const [list, purchases] = await Promise.all([
    api(`/cleanings?from=${addDays(t, -1)}&to=${addDays(t, 60)}&status=assigned,accepted,in_progress,declined`),
    api('/purchases?status=needed'),
  ]);
  const active = list.filter((c) => c.status !== 'declined' && c.date >= t || c.status === 'in_progress');
  const pending = active.filter((c) => c.status === 'assigned');
  const next = active.find((c) => c.status === 'in_progress') || active.find((c) => c.status !== 'assigned') || null;
  const later = active.filter((c) => c !== next && c.status !== 'assigned').slice(0, 5);
  // в день уборки — код доступа прямо на главной
  if (next && next.date === t && ['accepted', 'in_progress'].includes(next.status)) {
    next.access = (await api(`/cleanings/${next.id}`).catch(() => ({}))).access;
  }
  const name = state.me.name.split(' ')[0];

  return {
    title: `Привет, ${name}`,
    subtitle: fullDate(t),
    content: [
      pushBanner(),

      pending.length > 0 && section(`Новые уборки · ${pending.length}`, null,
        pending.map((c) => h('div.card',
          h('div.meta', { style: { justifyContent: 'space-between', marginBottom: '8px' } },
            h('span.pill.orange', 'Подтвердите'), h('span.small.muted', TYPE[c.type])),
          h('div.hero-day', dayLabel(c.date, { long: true })),
          h('div.hero-time', timeRange(c)),
          c.note && h('div.note-box', { style: { marginTop: '12px' } }, c.note),
          h('div.btn-row', { style: { marginTop: '16px' } },
            h('button.btn.plain', { onclick: (e) => declineFlow(e.currentTarget, c) }, 'Не смогу'),
            h('button.btn.primary', {
              onclick: (e) => act(e.currentTarget, async () => { await post(`/cleanings/${c.id}/accept`); refreshSummary(); refresh(); }, 'Уборка принята'),
            }, 'Принять'))))),

      section('Ближайшая уборка', null,
        next ? nextCard(next) : h('div.card', emptyState('calendar', 'Пока уборок нет. Мы сообщим, когда шеф назначит новую.'))),

      later.length > 0 && section('Дальше', h('a.section-link', { href: '#/calendar' }, 'Календарь'),
        h('div.group', later.map((c) => cleaningRow(c, { showDate: true })))),

      section('Нужно докупить', h('a.section-link', { href: '#/purchases' }, purchases.length ? 'Все' : ''),
        purchases.length
          ? h('div.group', purchases.slice(0, 4).map((p) => row({
            icon: 'cart', title: p.title, sub: `${p.note ? p.note + ' · ' : ''}добавила ${p.author}`, onclick: () => (location.hash = '#/purchases'),
          })))
          : h('div.card.small.muted', { style: { textAlign: 'center' } }, 'Всё есть — список пуст')),

      h('div.section', h('div.quick',
        h('button', { onclick: () => problemSheet().then((ok) => ok && refresh()) },
          h('span.row-icon', { style: { background: 'var(--red)' } }, icon('alert')), h('b', 'Сообщить о проблеме')),
        h('button', { onclick: () => addPurchaseSheet().then((ok) => ok && refresh()) },
          h('span.row-icon', icon('cart')), h('b', 'Добавить в «Докупить»')))),

      apartmentCard() && section('Квартира', null, apartmentCard()),
    ],
  };
}

function nextCard(c) {
  const btn = c.status === 'in_progress'
    ? h('button.btn.primary.block', { onclick: () => (location.hash = `#/cleaning/${c.id}`) }, 'Продолжить уборку')
    : h('button.btn.tinted.block', { onclick: () => (location.hash = `#/cleaning/${c.id}`) }, 'Открыть чек-лист');
  return h('div.card.tappable', { onclick: (e) => { if (e.target.closest('button')) return; location.hash = `#/cleaning/${c.id}`; } },
    h('div.meta', { style: { justifyContent: 'space-between', marginBottom: '8px' } }, statusPill(c), h('span.small.muted', `${TYPE[c.type]} уборка`)),
    h('div.hero-day', dayLabel(c.date, { long: true })),
    h('div.hero-time', timeRange(c)),
    c.status === 'in_progress' && h('div', { style: { marginTop: '14px' } },
      h('div.small.muted', { style: { marginBottom: '6px' } }, `Чек-лист: ${c.done_items} из ${c.total_items}`),
      progressBar(c.done_items, c.total_items)),
    c.note && h('div.note-box', { style: { marginTop: '12px' } }, c.note),
    c.access && h('div', { style: { marginTop: '12px' } }, accessBox(c.access)),
    h('div', { style: { marginTop: '16px' } }, btn));
}

export async function declineFlow(btn, c) {
  const reason = h('textarea.textarea', { rows: 3, placeholder: 'Например: заболела, не успеваю после другой работы' });
  const ok = await sheet({
    title: 'Отказаться от уборки',
    doneText: 'Отказаться',
    build: () => h('div',
      h('div.note-box.warn', { style: { marginBottom: '16px' } }, `${dayLabel(c.date, { long: true })}, ${timeRange(c)}. Шеф получит уведомление и назначит другую уборщицу.`),
      field('Причина (необязательно)', reason)),
    onDone: () => post(`/cleanings/${c.id}/decline`, { reason: reason.value }),
  });
  if (ok) { toast('Шеф получил уведомление'); refreshSummary(); refresh(); }
}

// =============== шеф ===============
async function chiefHome() {
  const t = todayYmd();
  const [list, money_, problems, purchases] = await Promise.all([
    api(`/cleanings?from=${addDays(t, -7)}&to=${addDays(t, 30)}`),
    api('/money'),
    api('/problems?status=open'),
    api('/purchases?status=needed'),
  ]);
  const attention = list.filter((c) => c.date >= t && ['unassigned', 'declined'].includes(c.status));
  const today = list.filter((c) => c.date === t && c.status !== 'cancelled');
  const upcoming = list.filter((c) => c.date > t && c.date <= addDays(t, 7) && !['unassigned', 'declined', 'cancelled'].includes(c.status));
  const reports = list.filter((c) => c.status === 'done' && c.date <= t).reverse().slice(0, 5);
  const unpaid = money_.people.reduce((s, p) => s + p.balance.total, 0);
  const waiting = list.filter((c) => c.date >= t && c.status === 'assigned').length;

  const addBtn = h('button.icon-btn', { onclick: () => cleaningEditor().then((id) => id && (location.hash = `#/cleaning/${id}`)), 'aria-label': 'Новая уборка' }, icon('plus'));

  return {
    title: 'Обзор',
    subtitle: fullDate(t),
    actions: [addBtn],
    content: [
      pushBanner(),
      apartmentStatus(),

      attention.length > 0 && section(`Нужно назначить · ${attention.length}`, null,
        h('div.group', attention.map((c) => row({
          left: h('span.row-icon', { style: { background: c.status === 'declined' ? 'var(--red)' : 'var(--orange)' } }, icon(c.status === 'declined' ? 'x' : 'user')),
          title: `${dayLabel(c.date)}${c.start_time ? ', ' + c.start_time : ''}`,
          sub: (c.status === 'declined'
            ? `${c.cleaner_name} отказалась${c.decline_reason ? ': ' + c.decline_reason : ''}`
            : `${TYPE[c.type]} · ${c.source === 'ical' ? 'из бронирования' : 'не назначена'}`)
            + (c.suggested ? ` · свободна ${c.suggested.name}` : ' · свободных нет'),
          // предложенную замену шеф подтверждает одним нажатием
          right: c.suggested
            ? h('button.btn.primary.small', { onclick: (e) => { e.stopPropagation(); act(e.currentTarget, () => assignSuggested(c)).then(refresh); } }, icon('check'), c.suggested.name)
            : h('button.btn.tinted.small', { onclick: (e) => { e.stopPropagation(); assignSheet(c).then((ok) => ok && refresh()); } }, 'Назначить'),
          onclick: () => (location.hash = `#/cleaning/${c.id}`),
        })))),

      h('div.section', h('div.group',
        row({ icon: 'alert', iconBg: problems.length ? 'var(--red)' : 'var(--gray)', title: 'Открытые проблемы', value: problems.length || 'нет', chevron: true, onclick: () => (location.hash = '#/problems') }),
        row({ icon: 'cart', title: 'Нужно докупить', value: purchases.length || 'нет', chevron: true, onclick: () => (location.hash = '#/purchases') }),
        row({ icon: 'wallet', iconBg: 'var(--green)', title: 'К выплате уборщицам', value: money(unpaid), chevron: true, onclick: () => (location.hash = '#/money') }),
        waiting > 0 && row({ icon: 'clock', iconBg: 'var(--orange)', title: 'Ждут подтверждения', value: waiting, chevron: true, onclick: () => (location.hash = '#/calendar') }))),

      section('Сегодня', null,
        today.length
          ? today.map((c) => todayCard(c))
          : h('div.card.small.muted', { style: { textAlign: 'center' } }, 'Сегодня уборок нет')),

      upcoming.length > 0 && section('На неделе', h('a.section-link', { href: '#/calendar' }, 'Календарь'),
        h('div.group', upcoming.map((c) => cleaningRow(c, { showDate: true })))),

      reports.length > 0 && section('Последние отчёты', null,
        h('div.group', reports.map((c) => reportRow(c, { showDate: true })))),
    ],
  };
}

/** Плашка «состояние квартиры»: определяется автоматически по уборкам и обновляется раз в минуту. */
function apartmentStatus() {
  const card = h('div.card.tappable.apt-card', { style: { marginBottom: '6px', minHeight: '80px' } });
  let target = '#/calendar';
  card.addEventListener('click', (e) => { if (!e.target.closest('button')) location.hash = target; });
  // 'YYYY-MM-DD HH:MM' → «сегодня в 11:00» / «пт, 30 октября в 11:00»
  const when = (dt) => `${dayLabel(dt.slice(0, 10)).toLowerCase()} в ${dt.slice(11, 16)}`;
  const btn = (text, cls, onclick) => h(`button.btn.small.${cls}`, { style: { marginTop: '10px', marginRight: '8px' }, onclick }, text);

  async function load() {
    let s;
    try { s = await api('/apartment-status'); } catch { return; }
    const c = s.cleaning;
    target = c ? `#/cleaning/${c.id}` : s.last ? `#/cleaning/${s.last.id}` : '#/calendar';
    const checkin = c?.end_time ? ` · заезд в ${c.end_time}` : '';
    const who = c ? (c.cleaner_name ? `${c.cleaner_name} — ${STATUS[c.status][0].toLowerCase()}` : 'уборщица не назначена') : 'уборка не запланирована';
    let view;
    let actions = [];
    if (s.state === 'cleaning') {
      view = ['accent', 'sparkles', 'Идёт уборка',
        `${c.cleaner_name} · ${c.total_items ? Math.round((c.done_items / c.total_items) * 100) : 0}% чек-листа`
          + `${c.started_at ? ' · начала в ' + timeOf(c.started_at) : ''}${checkin}`
          + `${c.inspection === 'issues' ? ' · при осмотре найдены проблемы' : ''}`];
    } else if (s.state === 'stay') {
      view = ['blue', 'users', 'Гости проживают',
        `Выезд ${when(s.stay.checkout)} · уборка: ${c ? c.cleaner_name || 'уборщица не назначена' : 'не запланирована'}`];
      if (s.stay.id) {
        actions.push(btn('Гости выехали', 'tinted', async () => {
          if (!(await confirmAction('Гости уже выехали?', 'Да, выехали', { message: 'Квартира станет «Грязно — нужна уборка»' }))) return;
          await act(null, () => post(`/stays/${s.stay.id}/checkout`), 'Отмечено');
          load();
        }));
      }
    } else if (s.state === 'dirty') {
      const since = s.ended ? `Гости выехали ${when(s.ended.checkout)}`
        : c.date < todayYmd() ? `Не убрано с ${shortDate(c.date)}` : `Гости выехали${c.start_time ? ' в ' + c.start_time : ''}`;
      view = ['red', 'alert', 'Грязно — нужна уборка', `${since} · ${who}${checkin}`];
      if (c && ['unassigned', 'declined'].includes(c.status)) actions.push(btn('Назначить уборщицу', 'primary', () => assignSheet(c).then((ok) => ok && refresh())));
      if (!c) actions.push(btn('Создать уборку', 'primary', () => cleaningEditor({ date: todayYmd() }).then((id) => id && refresh())));
      if (c && c.date > todayYmd()) {
        actions.push(btn('Перенести уборку на сегодня', 'tinted', async () => {
          await act(null, () => api(`/cleanings/${c.id}`, { method: 'PATCH', body: { date: todayYmd() } }),
            c.cleaner_id ? `Перенесено, ${c.cleaner_name} получит уведомление` : 'Перенесено на сегодня');
          refresh();
        }));
      }
      actions.push(btn('Уже убрано', 'plain', async () => {
        if (!(await confirmAction('Квартира уже убрана?', 'Да, убрана', { message: 'Например, уборку сделали без приложения' }))) return;
        await act(null, () => post('/apartment/cleaned'), 'Отмечено');
        load();
      }));
    } else {
      view = ['green', 'check', 'Квартира готова к заселению',
        [s.manualClean && (!s.last || s.manualClean > s.last.finished_at) ? `Отмечена убранной ${ago(s.manualClean)}`
          : s.last ? `Убрана ${ago(s.last.finished_at)} · ${s.last.cleaner_name}` : 'Уборок ещё не было',
          s.nextStay ? `следующий заезд ${when(s.nextStay.checkin)}` : s.next && `следующая уборка: ${dayLabel(s.next.date).toLowerCase()}`].filter(Boolean).join(' · ')];
      actions.push(btn('Гости заселились', 'tinted', () => checkinSheet(s).then((ok) => ok && refresh())));
    }
    const [color, ic, title, sub] = view;
    card.className = `card tappable apt-card ${s.state}`;
    clear(card,
      h('div.apt-status',
        h('span.apt-icon', { style: { background: `var(--${color})` } }, icon(ic)),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div.apt-title', title), h('div.apt-sub', sub), actions.length > 0 && h('div', actions))),
      s.state === 'cleaning' && h('div', { style: { marginTop: '14px' } }, progressBar(c.done_items, c.total_items)));
  }

  load();
  const timer = setInterval(() => (card.isConnected ? load() : clearInterval(timer)), 60_000);
  return card;
}

/** Шеф отмечает заселение гостей вручную (если бронирования не подключены по iCal). */
function checkinSheet(s) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const outDate = s.next?.date || addDays(todayYmd(), 1);
  const f = {
    inDate: h('input.input', { type: 'date', value: todayYmd() }),
    inTime: h('input.input', { type: 'time', value: `${pad(now.getHours())}:${pad(now.getMinutes())}` }),
    outDate: h('input.input', { type: 'date', value: outDate }),
    outTime: h('input.input', { type: 'time', value: s.next?.start_time || s.times?.checkout || '11:00' }),
  };
  return sheet({
    title: 'Гости заселились',
    doneText: 'Сохранить',
    build: () => h('div',
      h('div.field-row', field('Заезд', f.inDate), field('Время', f.inTime)),
      h('div.field-row', field('Выезд', f.outDate), field('Время', f.outTime)),
      h('div.section-foot', { style: { margin: '0 4px' } },
        'До выезда квартира будет «Гости проживают». Если на дату выезда нет уборки — она создастся сама, останется назначить уборщицу.')),
    onDone: async () => {
      await post('/stays', { checkin: `${f.inDate.value} ${f.inTime.value}`, checkout: `${f.outDate.value} ${f.outTime.value}` });
      toast('Отмечено: гости проживают');
    },
  });
}

function todayCard(c) {
  return h('div.card.tappable', { onclick: () => (location.hash = `#/cleaning/${c.id}`) },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      h('span.avatar', { style: { background: c.cleaner_color || 'var(--gray)' } }, (c.cleaner_name || '?')[0]),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 600 } }, c.cleaner_name || 'Не назначена'),
        h('div.small.muted', `${TYPE[c.type]} · ${timeRange(c)}`)),
      statusPill(c)),
    ['in_progress', 'done'].includes(c.status) && h('div', { style: { marginTop: '14px' } },
      h('div.small.muted', { style: { marginBottom: '6px', display: 'flex', justifyContent: 'space-between' } },
        h('span', `Чек-лист ${c.done_items}/${c.total_items}`), h('span', c.videos ? `видео: ${c.videos}` : '')),
      progressBar(c.done_items, c.total_items, c.status === 'done' ? 'green' : '')));
}
