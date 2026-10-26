import {
  h, icon, api, post, state, isChief, section, row, field, segmented, clear, sheet, toast, act, confirmAction,
  avatar, COLORS, money, emptyState, ago, plural,
} from '../core.js';
import { pushState, subscribePush, isIos, isStandalone, refresh } from '../app.js';
import { apartmentCard } from './shared.js';

// =============== общие пункты ===============
function notificationsRow() {
  const st = pushState();
  const value = { granted: 'включены', denied: 'запрещены', default: 'выключены', unsupported: 'недоступны' }[st];
  return row({
    icon: 'bell', iconBg: 'var(--red)', title: 'Push-уведомления', value, chevron: st !== 'granted',
    onclick: async () => {
      if (st === 'granted') return toast('Уведомления уже включены');
      if (isIos() && !isStandalone()) return toast('Сначала добавьте сайт на экран «Домой» через «Поделиться»', true);
      if (st === 'denied') return toast('Разрешите уведомления в настройках браузера', true);
      try { await subscribePush(); toast('Уведомления включены'); refresh(); } catch (e) { toast(e.message, true); }
    },
  });
}

function passwordRow() {
  return row({
    icon: 'key', iconBg: 'var(--gray)', title: 'Сменить пароль', chevron: true,
    onclick: () => {
      const current = h('input.input', { type: 'password', autocomplete: 'current-password' });
      const next = h('input.input', { type: 'password', autocomplete: 'new-password', placeholder: 'Минимум 6 символов' });
      sheet({
        title: 'Смена пароля', doneText: 'Сохранить',
        build: () => h('div', field('Текущий пароль', current), field('Новый пароль', next)),
        onDone: async () => { await post('/me/password', { current: current.value, password: next.value }); toast('Пароль изменён'); },
      });
    },
  });
}

function logoutRow() {
  return row({
    icon: 'logout', iconBg: 'var(--gray)', title: 'Выйти', cls: 'destructive',
    onclick: async () => {
      if (!(await confirmAction('Выйти из аккаунта?', 'Выйти', { destructive: true }))) return;
      await post('/logout');
      location.hash = '#/login';
    },
  });
}

// =============== шеф: «Ещё» ===============
export async function moreView() {
  if (!isChief()) { location.hash = '#/profile'; return { title: '', content: null }; }
  const [m, s] = await Promise.all([api('/money'), api('/settings')]);
  const unpaid = m.people.reduce((sum, p) => sum + p.balance.total, 0);
  return {
    title: 'Ещё',
    content: [
      h('div.section', h('div.group',
        row({ icon: 'wallet', iconBg: 'var(--green)', title: 'Выплаты уборщицам', value: money(unpaid), chevron: true, onclick: () => (location.hash = '#/money') }),
        row({ icon: 'clock', iconBg: 'var(--accent)', title: 'История уборок', chevron: true, onclick: () => (location.hash = '#/history') }),
        row({ icon: 'chart', iconBg: '#5E5CE6', title: 'Статистика уборщиц', chevron: true, onclick: () => (location.hash = '#/stats') }),
        row({ icon: 'users', iconBg: 'var(--blue)', title: 'Команда', value: state.users.filter((u) => u.role === 'cleaner' && u.active).length, chevron: true, onclick: () => (location.hash = '#/team') }))),
      section('Настройки', null, h('div.group',
        row({ icon: 'checklist', title: 'Чек-листы уборки', chevron: true, onclick: () => (location.hash = '#/templates') }),
        row({ icon: 'building', iconBg: 'var(--orange)', title: 'Квартира и тарифы', chevron: true, onclick: () => (location.hash = '#/settings') }),
        row({ icon: 'sync', iconBg: '#5E5CE6', title: 'Бронирования (iCal)', value: s.ical.length ? `${s.ical.length} ${plural(s.ical.length, 'ссылка', 'ссылки', 'ссылок')}` : 'не настроено', chevron: true, onclick: () => (location.hash = '#/bookings') }))),
      section('Аккаунт', null, h('div.group', notificationsRow(), passwordRow(), logoutRow())),
      h('div.section-foot', { style: { textAlign: 'center', marginTop: '24px' } }, `Вы вошли как ${state.me.name} (${state.me.login})`),
    ],
  };
}

// =============== уборщица: профиль ===============
export async function profileView() {
  const me = state.me;
  return {
    title: 'Профиль',
    content: [
      h('div.card', { style: { textAlign: 'center', padding: '24px' } },
        avatar(me, 'lg'),
        h('div', { style: { fontSize: '22px', fontWeight: 700 } }, me.name),
        h('div.small.muted', `логин: ${me.login}`)),
      h('div.section', h('div.group',
        row({ icon: 'ban', iconBg: 'var(--orange)', title: 'Когда я не могу', chevron: true, onclick: () => (location.hash = '#/availability') }),
        row({ icon: 'alert', iconBg: 'var(--red)', title: 'Проблемы и забытые вещи', chevron: true, onclick: () => (location.hash = '#/problems') }),
        row({ icon: 'wallet', iconBg: 'var(--green)', title: 'Заработок', chevron: true, onclick: () => (location.hash = '#/money') }))),
      apartmentCard() && section('Квартира', null, apartmentCard()),
      section('Настройки', null, h('div.group', notificationsRow(), passwordRow(), logoutRow())),
    ],
  };
}

// =============== команда ===============
export async function teamView() {
  const users = await api('/users');
  const openEditor = (u) => {
    const isNew = !u;
    u = u || { role: 'cleaner', color: COLORS[users.length % COLORS.length], active: 1 };
    let color = u.color;
    const name = h('input.input', { value: u.name || '', placeholder: 'Имя' });
    const login = h('input.input', { value: u.login || '', placeholder: 'например, olga', autocapitalize: 'none', autocorrect: 'off', disabled: !isNew });
    const password = h('input.input', { type: 'text', placeholder: isNew ? 'Минимум 6 символов' : 'Оставьте пустым, чтобы не менять', autocomplete: 'off' });
    const active = h('input', { type: 'checkbox', checked: !!u.active });
    const colors = h('div.colors');
    const drawColors = () => clear(colors, COLORS.map((c) => h('button', { type: 'button', class: c === color ? 'on' : '', style: { background: c }, onclick: () => { color = c; drawColors(); } })));
    drawColors();
    return sheet({
      title: isNew ? 'Новая уборщица' : u.name,
      doneText: isNew ? 'Добавить' : 'Сохранить',
      build: () => h('div',
        field('Имя', name),
        field('Логин для входа', login),
        field(isNew ? 'Пароль' : 'Новый пароль', password),
        u.role === 'cleaner' && h('div.field', h('span', 'Цвет в календаре'), colors),
        !isNew && u.id !== state.me.id && h('div.group', { style: { marginTop: '8px' } },
          h('label.row', h('div.row-main', h('div.row-title', 'Доступ к сервису'), h('div.row-sub', 'Отключите, если уборщица больше не работает')), h('span.switch', active, h('span')))),
        h('div.section-foot', { style: { margin: '12px 4px 0' } }, 'Передайте логин и пароль уборщице лично. Регистрации в сервисе нет.')),
      onDone: async () => {
        if (isNew) await post('/users', { name: name.value, login: login.value, password: password.value, color });
        else {
          const body = { name: name.value, color, active: active.checked };
          if (password.value) body.password = password.value;
          await api(`/users/${u.id}`, { method: 'PATCH', body });
        }
        toast(isNew ? 'Аккаунт создан' : 'Сохранено');
        const me = await api('/me');
        state.users = me.users;
        refresh();
      },
    });
  };

  const groupFor = (list) => h('div.group', list.map((u) => row({
    left: avatar(u),
    title: u.name,
    sub: `${u.login}${u.role === 'cleaner' ? ` · уборок: ${u.done_count}` : ' · шеф'}${u.active ? '' : ' · отключена'}`,
    chevron: true,
    cls: u.active ? '' : 'muted',
    onclick: () => openEditor(u),
  })));

  const cleanersList = users.filter((u) => u.role === 'cleaner');
  return {
    title: 'Команда',
    back: '#/more',
    large: true,
    actions: [h('button.icon-btn', { onclick: () => openEditor(null), 'aria-label': 'Добавить' }, icon('plus'))],
    content: [
      section('Уборщицы', null, cleanersList.length ? groupFor(cleanersList) : h('div.card', emptyState('users', 'Уборщиц пока нет')),
        h('button.btn.tinted.block', { style: { marginTop: '12px' }, onclick: () => openEditor(null) }, icon('plus'), 'Добавить уборщицу')),
      section('Шеф', null, groupFor(users.filter((u) => u.role === 'chief'))),
    ],
  };
}

// =============== чек-листы ===============
let tplTab = 'regular';
export async function templatesView() {
  const s = await api('/settings');
  // пункты храним как { text, photo }; старые шаблоны могли быть строками
  const templates = Object.fromEntries(Object.entries(s.templates).map(([k, secs]) => [k, secs.map((sec) => ({
    ...sec, items: sec.items.map((i) => (typeof i === 'string' ? { text: i, photo: false } : { text: i.text, photo: !!i.photo })),
  }))]));
  const body = h('div');
  let dirty = false;
  const saveBtn = h('button.btn.primary.block', { onclick: save }, 'Сохранить чек-листы');

  function draw() {
    const tpl = templates[tplTab];
    clear(body,
      tpl.map((sec, si) => h('div.section', { style: { marginTop: si ? '22px' : '4px' } },
        h('input.tpl-section-name', { value: sec.section, placeholder: 'Название раздела', oninput: (e) => { sec.section = e.target.value; dirty = true; } }),
        h('div.group',
          sec.items.map((item, ii) => h('div.tpl-item',
            h('input', { value: item.text, placeholder: 'Пункт', oninput: (e) => { item.text = e.target.value; dirty = true; } }),
            h('button.icon-btn.tpl-photo', {
              class: item.photo ? 'on' : '',
              'aria-label': 'Требовать фото',
              title: 'Требовать фото',
              onclick: (e) => {
                item.photo = !item.photo;
                dirty = true;
                e.currentTarget.classList.toggle('on', item.photo);
                toast(item.photo ? 'Пункт нужно будет подтвердить фото' : 'Фото для пункта не требуется');
              },
            }, icon('camera')),
            h('button.icon-btn', { 'aria-label': 'Удалить пункт', onclick: () => { sec.items.splice(ii, 1); dirty = true; draw(); } }, icon('x')))),
          h('button.row.accent', { onclick: () => { sec.items.push({ text: '', photo: false }); dirty = true; draw(); body.querySelectorAll('.section')[si].querySelector('.tpl-item:last-of-type input')?.focus(); } },
            h('div.row-main', h('div.row-title', '+ Добавить пункт')))),
        h('button', { style: { color: 'var(--red)', fontSize: '14px', margin: '8px 16px 0' }, onclick: async () => {
          if (await confirmAction(`Удалить раздел «${sec.section}»?`, 'Удалить', { destructive: true })) { tpl.splice(si, 1); dirty = true; draw(); }
        } }, 'Удалить раздел'))),
      h('div.section', h('button.btn.tinted.block', { onclick: () => { tpl.push({ section: 'Новый раздел', items: [{ text: '', photo: false }] }); dirty = true; draw(); } }, icon('plus'), 'Добавить раздел')));
  }

  async function save() {
    for (const k of Object.keys(templates)) {
      templates[k] = templates[k]
        .map((sec) => ({
          section: sec.section.trim() || 'Без названия',
          items: sec.items.map((i) => ({ text: i.text.trim(), photo: i.photo })).filter((i) => i.text),
        }))
        .filter((sec) => sec.items.length);
    }
    await act(saveBtn, () => api('/settings', { method: 'PUT', body: { templates } }), 'Сохранено. Применится к новым уборкам');
    dirty = false;
    draw();
  }

  draw();
  return {
    title: 'Чек-листы',
    back: '#/more',
    large: true,
    subtitle: 'Значок камеры — пункт подтверждается фото. Неотмеченные пункты вы увидите в отчёте',
    content: [
      segmented([['regular', 'Обычная уборка'], ['general', 'Генеральная']], tplTab, (v) => { tplTab = v; draw(); }),
      body,
      h('div.section', saveBtn),
    ],
  };
}

// =============== квартира и тарифы ===============
export async function settingsView() {
  const s = await api('/settings');
  const f = {
    name: h('input.input', { value: s.apartment.name || '' }),
    address: h('input.input', { value: s.apartment.address || '', placeholder: 'Улица, дом, квартира, подъезд, этаж' }),
    info: h('textarea.textarea', { rows: 6 }, s.apartment.info || ''),
    access: h('textarea.textarea', { rows: 3, placeholder: 'Например: ключница слева от двери, код 2580' }, s.apartment.access || ''),
    checkout: h('input.input', { type: 'time', value: s.times.checkout }),
    checkin: h('input.input', { type: 'time', value: s.times.checkin }),
    regular: h('input.input', { type: 'number', inputmode: 'numeric', value: s.rates.regular }),
    general: h('input.input', { type: 'number', inputmode: 'numeric', value: s.rates.general }),
    retention: h('select.select', [[14, '14 дней'], [30, '30 дней'], [60, '60 дней'], [90, '90 дней'], [0, 'Не удалять']].map(([v, l]) =>
      h('option', { value: v, selected: +s.video_retention_days === v }, l))),
  };
  const saveBtn = h('button.btn.primary.block', {
    onclick: async () => {
      await act(saveBtn, () => api('/settings', {
        method: 'PUT',
        body: {
          apartment: { name: f.name.value, address: f.address.value, info: f.info.value, access: f.access.value },
          times: { checkout: f.checkout.value, checkin: f.checkin.value },
          rates: { regular: +f.regular.value || 0, general: +f.general.value || 0 },
          video_retention_days: +f.retention.value,
        },
      }), 'Сохранено');
      state.apartment = { name: f.name.value, address: f.address.value, info: f.info.value };
    },
  }, 'Сохранить');

  return {
    title: 'Квартира и тарифы',
    back: '#/more',
    large: true,
    content: [
      section('Квартира', null, h('div.card',
        field('Название', f.name), field('Адрес', f.address),
        field('Инструкция для уборщиц', f.info),
        h('div.small.muted', 'Wi‑Fi, где лежит бельё и средства, куда выносить мусор. Уборщицы видят это всегда. Код от ключницы сюда не пишите.'))),
      section('Доступ в квартиру', null, h('div.card',
        field('Код ключницы, замка, где ключи', f.access),
        h('div.small.muted', 'Уборщица увидит это только в день своей уборки и только после того, как примет её. После уборки код снова скрывается.'))),
      section('Время по умолчанию', null, h('div.card',
        h('div.field-row', field('Выезд гостей', f.checkout), field('Заезд гостей', f.checkin)),
        h('div.small.muted', 'Используется для уборок, созданных из бронирований.'))),
      section('Оплата уборщицам', null, h('div.card',
        h('div.field-row', field('Обычная, ₽', f.regular), field('Генеральная, ₽', f.general)),
        h('div.small.muted', 'Подставляется в новые уборки. Для отдельной уборки сумму можно изменить.'))),
      section('Видео-отчёты', null, h('div.card',
        field('Хранить видео', f.retention),
        h('div.small.muted', 'Старые видео удаляются, чтобы не переполнить сервер. Чек-листы и комментарии сохраняются навсегда.'))),
      h('div.section', saveBtn),
    ],
  };
}

// =============== бронирования (iCal) ===============
export async function bookingsView() {
  const s = await api('/settings');
  const feeds = s.ical.length ? s.ical : [];
  const list = h('div');
  const statusEl = h('div');

  function draw() {
    clear(list, feeds.length
      ? feeds.map((f, i) => h('div.card',
        field('Площадка', h('input.input', { value: f.name, placeholder: 'Авито, Суточно.ру, Airbnb…', oninput: (e) => { f.name = e.target.value; } })),
        field('iCal-ссылка', h('input.input', { value: f.url, placeholder: 'https://…', inputmode: 'url', autocapitalize: 'none', oninput: (e) => { f.url = e.target.value.trim(); } })),
        h('button', { style: { color: 'var(--red)', fontSize: '15px' }, onclick: () => { feeds.splice(i, 1); draw(); } }, 'Удалить ссылку')))
      : h('div.card', emptyState('link', 'Ссылок пока нет')));
    const st = s.ical_status;
    clear(statusEl, st && h('div.note-box', { class: st.ok ? '' : 'warn', style: { marginTop: '12px' } },
      h('b', st.ok ? 'Последняя синхронизация: ' : 'Ошибка синхронизации: '), ago(st.at), h('div.small', st.message)));
  }

  const saveFeeds = () => api('/settings', { method: 'PUT', body: { ical: feeds.filter((f) => f.url).map((f, i) => ({ name: f.name.trim() || `Площадка ${i + 1}`, url: f.url })) } });
  const syncBtn = h('button.btn.primary.block', {
    onclick: async () => {
      const r = await act(syncBtn, async () => { await saveFeeds(); return post('/ical/sync'); });
      s.ical_status = r;
      toast(r.ok ? r.message : 'Есть ошибки — см. ниже', !r.ok);
      draw();
    },
  }, icon('sync'), 'Сохранить и синхронизировать');

  draw();
  return {
    title: 'Бронирования',
    back: '#/more',
    large: true,
    subtitle: 'После каждого выезда гостя уборка создаётся сама — останется назначить уборщицу',
    content: [
      list,
      h('button.btn.tinted.block', { style: { marginTop: '12px' }, onclick: () => { feeds.push({ name: '', url: '' }); draw(); } }, icon('plus'), 'Добавить площадку'),
      h('div.section', syncBtn, statusEl),
      section('Где взять ссылку', null, h('div.card.small', { style: { lineHeight: 1.5 } },
        h('div', h('b', 'Авито: '), 'Объявление → Календарь → Синхронизация календарей → «Экспорт», скопируйте ссылку.'),
        h('div', { style: { marginTop: '8px' } }, h('b', 'Суточно.ру: '), 'Личный кабинет → Календарь объекта → Синхронизация → ссылка для экспорта.'),
        h('div', { style: { marginTop: '8px' } }, h('b', 'Airbnb: '), 'Календарь → Доступность → Синхронизация календарей → Экспорт календаря.'),
        h('div', { style: { marginTop: '8px' } }, h('b', 'Booking: '), 'Экстранет → Цены и наличие → Синхронизация календарей → Экспорт.'),
        h('div.muted', { style: { marginTop: '10px' } }, 'Синхронизация идёт автоматически каждые 30 минут. Если бронь отменят, уборка тоже отменится, а уборщица получит уведомление.'))),
    ],
  };
}
