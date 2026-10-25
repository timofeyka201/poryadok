import { h, clear, icon, api, post, state, isChief, sheet, emptyState, ago } from './core.js';
import { loginView } from './views/login.js';
import { homeView } from './views/home.js';
import { calendarView } from './views/calendar.js';
import { cleaningView } from './views/cleaning.js';
import { purchasesView } from './views/purchases.js';
import { problemsView } from './views/problems.js';
import { moneyView } from './views/money.js';
import { moreView, profileView, teamView, templatesView, settingsView, bookingsView } from './views/more.js';

const routes = [
  ['/', homeView],
  ['/calendar', calendarView],
  ['/cleaning/:id', cleaningView],
  ['/purchases', purchasesView],
  ['/problems', problemsView],
  ['/money', moneyView],
  ['/more', moreView],
  ['/profile', profileView],
  ['/team', teamView],
  ['/templates', templatesView],
  ['/settings', settingsView],
  ['/bookings', bookingsView],
];

const TABS = {
  chief: [
    ['/', 'home', 'Обзор', 'attention'],
    ['/calendar', 'calendar', 'Календарь'],
    ['/purchases', 'cart', 'Покупки', 'purchases'],
    ['/problems', 'alert', 'Проблемы', 'problems'],
    ['/more', 'more', 'Ещё'],
  ],
  cleaner: [
    ['/', 'home', 'Главная', 'pending'],
    ['/calendar', 'calendar', 'Календарь'],
    ['/purchases', 'cart', 'Покупки', 'purchases'],
    ['/money', 'wallet', 'Заработок'],
    ['/profile', 'user', 'Профиль'],
  ],
};
const TAB_PATHS = new Set(['/', '/calendar', '/purchases', '/problems', '/money', '/more', '/profile']);

const root = document.getElementById('app');
let renderSeq = 0;

function match(path) {
  for (const [pattern, view] of routes) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const m = path.match(re);
    if (m) return { view, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

async function loadMe() {
  const data = await api('/me');
  Object.assign(state, { me: data.user, users: data.users, apartment: data.apartment, today: data.today, vapidPublicKey: data.vapidPublicKey });
}

export async function render({ keepScroll = false } = {}) {
  const seq = ++renderSeq;
  const path = (location.hash.slice(1) || '/').split('?')[0];

  if (path === '/login') {
    state.me = null;
    clear(root, loginView());
    return;
  }
  if (!state.me) {
    try { await loadMe(); } catch { return; }
    registerSW();
    refreshSummary();
  }

  const m = match(path) || match('/');
  const scrollY = window.scrollY;
  let view;
  try {
    view = await m.view(m.params);
  } catch (e) {
    view = { title: 'Ошибка', back: true, content: emptyState('alert', e.message || 'Не удалось загрузить') };
  }
  if (seq !== renderSeq) return; // пользователь уже ушёл на другую страницу

  const isTab = TAB_PATHS.has(path);
  const large = view.large ?? isTab;
  const topbar = h('header.topbar', { class: large ? '' : 'compact' },
    h('div.tb-side',
      view.back && h('button.back-btn', { onclick: () => (history.length > 1 ? history.back() : (location.hash = typeof view.back === 'string' ? view.back : '#/')) },
        icon('chevL'), view.backText || 'Назад')),
    h('div.tb-title', view.title),
    h('div.tb-side.right', view.actions, isTab && bellButton()));

  const page = h('main.page',
    large && h('h1.large-title', view.title),
    large && view.subtitle && h('div.subtitle', view.subtitle),
    view.content);

  clear(root, topbar, page, tabbar(path));
  window.scrollTo(0, keepScroll ? scrollY : 0);
  onScroll();
  updateBadges();
}
export const refresh = () => render({ keepScroll: true });

function tabbar(path) {
  const tabs = TABS[state.me.role];
  const fallback = path.startsWith('/cleaning') ? '/calendar' : isChief() ? '/more' : '/profile';
  const active = tabs.some(([href]) => href === path) ? path : fallback;
  return h('nav.tabbar', h('div.tabbar-inner', tabs.map(([href, ic, label, badgeKey]) =>
    h('a.tab', { href: '#' + href, class: href === active ? 'active' : '', 'data-badge': badgeKey || '' },
      icon(ic), label, h('span.badge.hidden')))));
}

function bellButton() {
  return h('button.icon-btn.bell', { onclick: openNotifications, 'aria-label': 'Уведомления' }, icon('bell'), h('span.badge.hidden'));
}

function setBadge(el, n) {
  if (!el) return;
  el.textContent = n > 99 ? '99+' : n;
  el.classList.toggle('hidden', !n);
}
function updateBadges() {
  const s = state.summary;
  document.querySelectorAll('.tab[data-badge]').forEach((t) => {
    const key = t.dataset.badge;
    setBadge(t.querySelector('.badge'), key ? s[key] || 0 : 0);
  });
  setBadge(document.querySelector('.bell .badge'), s.unread || 0);
  if (navigator.setAppBadge) navigator.setAppBadge(s.unread || 0).catch(() => {});
}

export async function refreshSummary() {
  if (!state.me) return;
  try { state.summary = await api('/summary'); updateBadges(); } catch {}
}
setInterval(refreshSummary, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSummary(); });

function onScroll() {
  document.querySelector('.topbar')?.classList.toggle('scrolled', window.scrollY > 30);
}
window.addEventListener('scroll', onScroll, { passive: true });

async function openNotifications() {
  const items = await api('/notifications');
  post('/notifications/read').then(refreshSummary);
  sheet({
    title: 'Уведомления',
    cancelText: 'Закрыть',
    build: (close) => items.length
      ? h('div.group', items.map((n) => h('button.notif', {
        onclick: () => { close(); if (n.link) location.hash = n.link; },
      },
      h('span.unread-dot', { class: n.read ? 'read' : '' }),
      h('div', h('div.notif-title', n.title), n.body && h('div.notif-body', n.body), h('div.notif-time', ago(n.created_at))))))
      : emptyState('bell', 'Уведомлений пока нет'),
  });
}

// ---------- PWA и push-уведомления ----------
let swReg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
    if (Notification?.permission === 'granted') subscribePush();
  } catch {}
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
export const pushState = () => (!pushSupported() ? 'unsupported' : Notification.permission);

function b64ToUint8(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function subscribePush() {
  if (!pushSupported()) throw new Error('Этот браузер не поддерживает уведомления');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Уведомления запрещены в настройках браузера');
  const reg = swReg || (await navigator.serviceWorker.ready);
  const sub = (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(state.vapidPublicKey) }));
  await post('/push/subscribe', sub.toJSON());
}

window.addEventListener('hashchange', () => render());
render();
