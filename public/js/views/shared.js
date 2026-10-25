// Компоненты, которые используются на нескольких экранах.
import {
  h, icon, api, post, upload, state, isChief, sheet, toast, field, segmented, statusPill, dayLabel, TYPE, cleaners,
  todayYmd, clear, progressBar,
} from '../core.js';
import { pushState, subscribePush, isIos, isStandalone, refreshSummary } from '../app.js';

export function cleaningRow(c, { showDate = false } = {}) {
  const chief = isChief();
  const color = c.status === 'cancelled' ? 'var(--text-3)' : chief ? (c.cleaner_color || 'var(--text-3)') : 'var(--accent)';
  return h('button.row', { onclick: () => (location.hash = `#/cleaning/${c.id}`), style: c.status === 'cancelled' ? { opacity: 0.55 } : null },
    h('div.ci',
      h('div.ci-time', h('b', c.start_time || '—'), h('small', c.end_time ? `до ${c.end_time}` : TYPE[c.type].slice(0, 5) + '.')),
      h('span.ci-bar', { style: { background: color } })),
    h('div.row-main',
      h('div.row-title', chief ? (c.cleaner_name || 'Не назначена') : `${TYPE[c.type]} уборка`),
      (showDate || chief) && h('div.row-sub', [showDate && dayLabel(c.date), chief && TYPE[c.type]].filter(Boolean).join(' · ')),
      h('div', { style: { marginTop: '5px' } },
        statusPill(c))),
    h('span.row-chev', icon('chevR')));
}

/** Создание или изменение уборки (шеф). */
export function cleaningEditor({ cleaning, date } = {}) {
  const c = cleaning || {};
  const f = {
    date: h('input.input', { type: 'date', value: c.date || date || todayYmd(), required: true }),
    start: h('input.input', { type: 'time', value: c.start_time || '11:00' }),
    end: h('input.input', { type: 'time', value: c.end_time || '' }),
    cleaner: h('select.select',
      h('option', { value: '' }, 'Пока не назначать'),
      cleaners().map((u) => h('option', { value: u.id, selected: u.id === c.cleaner_id }, u.name))),
    pay: h('input.input', { type: 'number', inputmode: 'numeric', min: 0, step: 50, value: c.pay_amount ?? '', placeholder: 'По тарифу' }),
    note: h('textarea.textarea', { placeholder: 'Например: гости с ребёнком — поставить детскую кроватку', rows: 3 }, c.note || ''),
  };
  let type = c.type || 'regular';
  return sheet({
    title: cleaning ? 'Изменить уборку' : 'Новая уборка',
    doneText: cleaning ? 'Сохранить' : 'Создать',
    build: () => h('div',
      segmented([['regular', 'Обычная'], ['general', 'Генеральная']], type, (v) => { type = v; }),
      field('Дата', f.date),
      h('div.field-row', field('Начало', f.start), field('Закончить до', f.end)),
      field('Уборщица', f.cleaner),
      field('Оплата уборщице, ₽', f.pay),
      field('Заметка для уборщицы', f.note),
      cleaning && ['in_progress', 'done'].includes(c.status) && type !== c.type &&
        h('div.section-foot', 'Чек-лист начатой уборки не изменится.')),
    onDone: async () => {
      if (!f.date.value) throw new Error('Укажите дату');
      const body = {
        date: f.date.value, start_time: f.start.value, end_time: f.end.value, type,
        cleaner_id: f.cleaner.value ? +f.cleaner.value : null, note: f.note.value,
      };
      if (f.pay.value !== '') body.pay_amount = +f.pay.value;
      if (cleaning) {
        await api(`/cleanings/${c.id}`, { method: 'PATCH', body });
        toast('Сохранено');
        return c.id;
      }
      const created = await post('/cleanings', body);
      toast(body.cleaner_id ? 'Уборка создана, уборщица получит уведомление' : 'Уборка создана');
      return created.id;
    },
  });
}

/** Быстрое назначение уборщицы. */
export function assignSheet(c) {
  return sheet({
    title: 'Назначить уборщицу',
    build: (close) => h('div',
      h('div.section-caption', `${dayLabel(c.date)} · ${c.start_time || ''}`),
      h('div.group', cleaners().map((u) => h('button.row.has-icon', {
        onclick: async () => {
          try {
            await api(`/cleanings/${c.id}`, { method: 'PATCH', body: { cleaner_id: u.id } });
            toast(`Назначена ${u.name}`);
            refreshSummary();
            close(true);
          } catch (e) { toast(e.message, true); }
        },
      },
      h('span.avatar', { style: { background: u.color, width: '32px', height: '32px', fontSize: '15px' } }, u.name[0]),
      h('div.row-main', h('div.row-title', u.name)),
      c.cleaner_id === u.id && h('span.pill.red', 'отказалась'))))),
  });
}

function filePicker({ accept, multiple = true, label, ic }) {
  const input = h('input', { type: 'file', accept, multiple, class: 'hidden' });
  const list = h('div.small.muted', { style: { margin: '8px 4px 0' } });
  input.addEventListener('change', () => {
    const n = input.files.length;
    clear(list, n ? `Выбрано файлов: ${n}` : '');
  });
  const btn = h('button.btn.tinted.block', { type: 'button', onclick: () => input.click() }, icon(ic), label);
  return { el: h('div', { style: { marginBottom: '14px' } }, input, btn, list), input };
}

export function progressBlock() {
  const label = h('span');
  const pct = h('span');
  const bar = progressBar(0, 1);
  const el = h('div.upload-progress.hidden', h('div.small.muted', label, pct), bar);
  return {
    el,
    set(text, frac) {
      el.classList.remove('hidden');
      label.textContent = text;
      pct.textContent = `${Math.round(frac * 100)}%`;
      bar.firstChild.style.width = `${frac * 100}%`;
    },
    hide() { el.classList.add('hidden'); },
  };
}

/** Сообщить о проблеме: поломка, забытая вещь, другое. */
export function problemSheet({ cleaningId } = {}) {
  let kind = 'breakage';
  const desc = h('textarea.textarea', { rows: 4, placeholder: 'Что случилось? Где именно?' });
  const photos = filePicker({ accept: 'image/*', label: 'Добавить фото', ic: 'camera' });
  const prog = progressBlock();
  return sheet({
    title: 'Новая проблема',
    doneText: 'Отправить',
    build: () => h('div',
      segmented([['breakage', 'Поломка'], ['forgotten', 'Забытая вещь'], ['other', 'Другое']], kind, (v) => {
        kind = v;
        desc.placeholder = v === 'forgotten' ? 'Что забыли гости и куда вы это положили?' : 'Что случилось? Где именно?';
      }),
      field('Описание', desc),
      photos.el,
      prog.el),
    onDone: async () => {
      if (!desc.value.trim()) throw new Error('Опишите проблему');
      const form = new FormData();
      form.append('kind', kind);
      form.append('description', desc.value);
      if (cleaningId) form.append('cleaning_id', cleaningId);
      for (const f of photos.input.files) form.append('photos', f);
      await upload('/problems', form, (p) => prog.set('Загрузка фото', p));
      toast('Шеф получит уведомление');
      refreshSummary();
    },
  });
}

/** Добавить пункт в общий список «Докупить». */
export function addPurchaseSheet({ cleaningId } = {}) {
  const title = h('input.input', { placeholder: 'Например: средство для стёкол' });
  const note = h('input.input', { placeholder: 'Необязательно: сколько, какой марки' });
  return sheet({
    title: 'Нужно докупить',
    doneText: 'Добавить',
    build: () => h('div', field('Что купить', title), field('Комментарий', note),
      h('div.section-foot', { style: { margin: '0 4px' } }, 'Пункт увидят все уборщицы и шеф.')),
    onDone: async () => {
      if (!title.value.trim()) throw new Error('Что нужно купить?');
      await post('/purchases', { title: title.value, note: note.value, cleaning_id: cleaningId || null });
      toast('Добавлено в список');
      refreshSummary();
    },
  });
}

/** Отметить покупку: сумма и фото чека → компенсация в выплате. */
export function boughtSheet(p) {
  const amount = h('input.input', { type: 'number', inputmode: 'decimal', min: 0, placeholder: '0' });
  const receipt = filePicker({ accept: 'image/*', multiple: false, label: 'Фото чека', ic: 'camera' });
  const prog = progressBlock();
  return sheet({
    title: 'Куплено',
    doneText: 'Готово',
    build: () => h('div',
      h('div.card', { style: { marginBottom: '16px' } }, h('div', { style: { fontWeight: 600 } }, p.title), p.note && h('div.small.muted', p.note)),
      field('Сколько потратили, ₽', amount),
      receipt.el,
      prog.el,
      h('div.section-foot', { style: { margin: '0 4px' } },
        isChief() ? 'Покупка шефа не идёт в компенсацию.' : 'Сумма добавится к вашей следующей выплате.')),
    onDone: async () => {
      const form = new FormData();
      form.append('amount', amount.value || '0');
      if (receipt.input.files[0]) form.append('receipt', receipt.input.files[0]);
      await upload(`/purchases/${p.id}/bought`, form, (x) => prog.set('Загрузка чека', x));
      toast('Отмечено как купленное');
      refreshSummary();
    },
  });
}

/** Баннер с предложением включить push-уведомления. */
export function pushBanner() {
  const st = pushState();
  if (st === 'granted' || st === 'denied') return null;
  if (isIos() && !isStandalone()) {
    return h('div.banner',
      h('span.row-icon', icon('bell')),
      h('div.banner-text', h('b', 'Чтобы получать уведомления'),
        'Нажмите «Поделиться» внизу Safari → «На экран „Домой“» и откройте приложение с иконки.'));
  }
  if (st === 'unsupported') return null;
  const el = h('div.banner',
    h('span.row-icon', icon('bell')),
    h('div.banner-text', h('b', 'Включите уведомления'), isChief() ? 'Узнавайте об отчётах и проблемах сразу' : 'Чтобы сразу узнавать о новых уборках'),
    h('button.btn.primary.small', {
      onclick: async (e) => {
        e.target.disabled = true;
        try { await subscribePush(); toast('Уведомления включены'); el.remove(); }
        catch (err) { toast(err.message, true); e.target.disabled = false; }
      },
    }, 'Включить'));
  return el;
}

export const apartmentCard = () => {
  const a = state.apartment || {};
  if (!a.address && !a.info) return null;
  return h('div.card',
    h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: a.info ? '12px' : 0 } },
      h('span.row-icon', icon('building')),
      h('div', h('div', { style: { fontWeight: 600 } }, a.name || 'Квартира'), a.address && h('div.small.muted', a.address))),
    a.info && h('div.pre.small', { style: { color: 'var(--text)' } }, a.info));
};
