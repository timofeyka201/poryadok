// Общие помощники интерфейса: DOM, иконки, API, листы, тосты, форматирование.

export const state = { me: null, users: [], apartment: null, summary: {}, today: '' };

// ---------- DOM ----------
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = name === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(name || 'div');
  if (classes.length) el.setAttribute('class', classes.join(' '));
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', [el.getAttribute('class'), v].filter(Boolean).join(' '));
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el, ...children) => { el.replaceChildren(); append(el, children); return el; };

// ---------- icons (в духе SF Symbols) ----------
const ICONS = {
  home: '<path d="M3.5 10.2 12 3.5l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4.2v-5.8H9.2v5.8H5A1.5 1.5 0 0 1 3.5 19z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  cart: '<path d="M3 4h2.2l2.3 10.6a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.1"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16.5 15h.01M6 6l9.5-2.6a1.5 1.5 0 0 1 1.9 1.2L17.6 6"/>',
  alert: '<path d="M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.3h.01"/>',
  more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevR: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  chevL: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10.5 5-3v9l-5-3"/>',
  camera: '<path d="M4.5 7.5h3l1.6-2.5h5.8l1.6 2.5h3a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5z"/><circle cx="12" cy="13.3" r="3.6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1-3.8 4-5.5 7.5-5.5s6.5 1.7 7.5 5.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5c.8-3.2 3.4-4.8 6.5-4.8s5.7 1.6 6.5 4.8"/><path d="M15.5 5.3a3.4 3.4 0 0 1 0 6.4M18 14.9c1.8.6 3 2.1 3.5 4.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8.5M4 13a8 8 0 0 0 14.5 4.5l1.5-2"/><path d="M4 4v4.5h4.5M20 20v-4.5h-4.5"/>',
  logout: '<path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1"/><circle cx="4.8" cy="12" r="1"/><circle cx="4.8" cy="17.5" r="1"/>',
  checklist: '<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="m8 9 1.5 1.5L12.5 7.5M8 15l1.5 1.5 3-3M15 9.3h1.5M15 15.3h1.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7M6.5 6.5l.8 12.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.8-12.2"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  building: '<path d="M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 15 5v15.5M15 9.5h3.5A1.5 1.5 0 0 1 20 11v9.5M3 20.5h18M8.5 7.5h3M8.5 11h3M8.5 14.5h3"/>',
  sparkles: '<path d="M10 3.5l1.6 4.4L16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6zM17.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-1.5 1.5-1.4-1.4-6.6 6.6a2.1 2.1 0 0 1-3-3l6.6-6.6-1.4-1.4L15.2 7z" transform="rotate(0)"/><path d="M14.5 4.5a5 5 0 0 1 5 5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  message: '<path d="M4.5 5h15A1.5 1.5 0 0 1 21 6.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17h-1A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5z"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
};
export function icon(name, cls = '') {
  const el = h('svg', { class: `i ${cls}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  el.innerHTML = ICONS[name] || '';
  return el;
}

// ---------- API ----------
export class ApiError extends Error {}
export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    throw new ApiError('Нет связи с сервером');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { location.hash = '#/login'; throw new ApiError(data.error || 'Нужно войти'); }
  if (!res.ok) throw new ApiError(data.error || 'Ошибка');
  return data;
}
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });

/** Загрузка файлов с прогрессом (для больших видео). */
export function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total, e.loaded, e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || (xhr.status === 413 ? 'Файл слишком большой' : 'Не удалось загрузить')));
    };
    xhr.onerror = () => reject(new ApiError('Связь прервалась. Попробуйте ещё раз'));
    xhr.send(form);
  });
}

// ---------- feedback ----------
export function toast(text, err = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div.toast', { class: err ? 'err' : '' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
/** Оборачивает async-действие: блокирует кнопку и показывает ошибку тостом. */
export async function act(btn, fn, okText) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (okText) toast(okText);
    return r;
  } catch (e) {
    toast(e.message || 'Ошибка', true);
    throw e;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function closeBackdrop(bd) {
  return new Promise((res) => {
    bd.classList.add('closing');
    setTimeout(() => { bd.remove(); res(); }, 200);
  });
}

/**
 * Модальный лист снизу (как в iOS).
 * build(close) возвращает содержимое; onDone — если задан, справа появляется кнопка действия.
 */
export function sheet({ title, build, doneText, onDone, cancelText = 'Отмена' }) {
  return new Promise((resolve) => {
    const bd = h('div.backdrop');
    let closed = false;
    const close = async (val) => { if (closed) return; closed = true; await closeBackdrop(bd); resolve(val); };
    const doneBtn = onDone && h('button.side.right', {
      onclick: async () => {
        doneBtn.disabled = true;
        try { const r = await onDone(); if (r !== false) close(r ?? true); }
        catch (e) { toast(e.message || 'Ошибка', true); }
        finally { doneBtn.disabled = false; }
      },
    }, doneText || 'Готово');
    const body = h('div.sheet-body');
    const sh = h('div.sheet', { onclick: (e) => e.stopPropagation() },
      h('div.sheet-grabber'),
      h('div.sheet-head',
        h('button.side', { onclick: () => close(null) }, cancelText),
        h('h2', title || ''),
        doneBtn || h('span.side')),
      body);
    clear(body, build(close));
    bd.append(sh);
    bd.addEventListener('click', () => close(null));
    document.body.append(bd);
    setTimeout(() => body.querySelector('input:not([type=file]):not([type=checkbox]),textarea')?.focus({ preventScroll: true }), 350);
  });
}

/** Меню действий снизу. actions: [{ text, value, destructive }] */
export function actionSheet({ title, message, actions }) {
  return new Promise((resolve) => {
    const bd = h('div.backdrop');
    const close = async (v) => { await closeBackdrop(bd); resolve(v); };
    bd.append(h('div.action-sheet', { onclick: (e) => e.stopPropagation() },
      h('div.action-group',
        (title || message) && h('div.msg', title && h('b', title), message),
        actions.map((a) => h('button', { class: a.destructive ? 'destructive' : '', onclick: () => close(a.value ?? a.text) }, a.text))),
      h('div.action-group', h('button.cancel', { onclick: () => close(null) }, 'Отмена'))));
    bd.addEventListener('click', () => close(null));
    document.body.append(bd);
  });
}
export const confirmAction = async (title, okText, { message, destructive = false } = {}) =>
  (await actionSheet({ title, message, actions: [{ text: okText, value: true, destructive }] })) === true;

// ---------- formatting ----------
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WD = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const WD_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const todayYmd = () => ymd(new Date());

export function dayLabel(s, { long = false } = {}) {
  const t = todayYmd();
  if (s === t) return 'Сегодня';
  if (s === addDays(t, 1)) return 'Завтра';
  if (s === addDays(t, -1)) return 'Вчера';
  const d = parseYmd(s);
  return long ? `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}` : `${WD_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function fullDate(s) {
  const d = parseYmd(s);
  return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export const shortDate = (s) => { const d = parseYmd(s.slice(0, 10)); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
export const money = (n) => `${Math.round(n || 0).toLocaleString('ru-RU')}\u00A0₽`;
export const timeOf = (dt) => (dt || '').slice(11, 16);
export function ago(dt) {
  const d = new Date(dt.replace(' ', 'T'));
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (dt.slice(0, 10) === todayYmd()) return `сегодня в ${timeOf(dt)}`;
  if (dt.slice(0, 10) === addDays(todayYmd(), -1)) return `вчера в ${timeOf(dt)}`;
  return `${shortDate(dt)} в ${timeOf(dt)}`;
}
export const fileSize = (b) => (b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} ГБ` : `${Math.max(1, Math.round(b / 1024 ** 2))} МБ`);
export const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
};

// ---------- domain ----------
export const isChief = () => state.me?.role === 'chief';
export const TYPE = { regular: 'Обычная', general: 'Генеральная' };
export const STATUS = {
  unassigned: ['Не назначена', 'gray'],
  assigned: ['Ждёт подтверждения', 'orange'],
  accepted: ['Принята', 'blue'],
  declined: ['Отказ', 'red'],
  in_progress: ['Идёт уборка', 'accent'],
  done: ['Завершена', 'green'],
  cancelled: ['Отменена', 'gray'],
};
export function statusPill(c) {
  let [label, color] = STATUS[c.status] || [c.status, 'gray'];
  if (!isChief() && c.status === 'assigned') label = 'Новая — подтвердите';
  if (c.status === 'in_progress' && c.total_items) label += ` · ${Math.round((c.done_items / c.total_items) * 100)}%`;
  return h('span.pill', { class: color }, label);
}
export const timeRange = (c) =>
  c.start_time && c.end_time ? `${c.start_time} – ${c.end_time}` : c.start_time ? `с ${c.start_time}` : c.end_time ? `до ${c.end_time}` : 'Время не указано';
export const userById = (id) => state.users.find((u) => u.id === id);
export const cleaners = () => state.users.filter((u) => u.role === 'cleaner' && u.active);
export const COLORS = ['#8E1B33', '#1F6FEB', '#248A3D', '#C25E00', '#8944AB', '#0E8A8A', '#B8336A', '#5E5CE6'];

// ---------- small components ----------
export const section = (title, link, ...children) =>
  h('div.section', h('div.section-head', h('div.section-title', title), link), children);

export function row({ icon: ic, iconBg, title, sub, value, chevron, onclick, cls, left, right }) {
  return h(onclick ? 'button.row' : 'div.row', { class: [ic || left ? 'has-icon' : '', cls].filter(Boolean).join(' '), onclick },
    left || (ic && h('span.row-icon', { style: { background: iconBg || 'var(--accent)' } }, icon(ic))),
    h('div.row-main', h('div.row-title', title), sub && h('div.row-sub', sub)),
    value != null && h('span.row-value', value),
    right,
    chevron && h('span.row-chev', icon('chevR')));
}

export function field(label, input) {
  return h('label.field', h('span', label), input);
}

export function segmented(options, value, onChange) {
  const el = h('div.seg');
  const render = () => clear(el, options.map(([v, label]) =>
    h('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => { value = v; render(); onChange(v); } }, label)));
  render();
  return el;
}

export function emptyState(ic, text) {
  return h('div.empty', icon(ic), h('div', text));
}

export const progressBar = (done, total, cls = '') =>
  h('div.progress', { class: cls }, h('div', { style: { width: `${total ? (done / total) * 100 : 0}%` } }));

export function avatar(u, cls = '') {
  return h('span.avatar', { class: cls, style: { background: u?.color || 'var(--gray)' } }, (u?.name || '?')[0].toUpperCase());
}
