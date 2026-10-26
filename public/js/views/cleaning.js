import {
  h, icon, api, post, upload, state, isChief, section, row, statusPill, dayLabel, timeRange, TYPE, money, clear,
  progressBar, act, toast, actionSheet, confirmAction, ago, fileSize, shortDate, timeOf, plural, avatar, compressImage,
} from '../core.js';
import { compressVideo, canCompressVideo, keepAwake } from '../video-compress.js';
import { cleaningEditor, assignSheet, problemSheet, addPurchaseSheet, progressBlock, accessBox, ratingStars } from './shared.js';
import { declineFlow } from './home.js';
import { refresh, refreshSummary } from '../app.js';

const PROBLEM_KIND = { breakage: ['Поломка', 'red'], forgotten: ['Забытая вещь', 'blue'], other: ['Другое', 'gray'] };

export async function cleaningView({ id }) {
  const c = await api(`/cleanings/${id}`);
  const chief = isChief();
  const mine = c.cleaner_id === state.me.id;
  const working = mine && c.status === 'in_progress';
  const needInspection = working && !c.inspection;
  const canCheck = working && !needInspection;
  const canReport = mine && ['in_progress', 'done'].includes(c.status);
  const reload = () => refresh();

  // ---------- шапка ----------
  const header = h('div.card',
    h('div.meta', { style: { justifyContent: 'space-between', marginBottom: '10px' } },
      h('div.meta', statusPill(c), c.source === 'ical' && h('span.pill.gray', 'из бронирования')),
      h('span.small.muted', `${TYPE[c.type]} уборка`)),
    h('div.hero-day', dayLabel(c.date, { long: true })),
    h('div.hero-time', timeRange(c)),
    chief && h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px', paddingTop: '14px', borderTop: '.5px solid var(--sep)' } },
      c.cleaner_id ? avatar({ name: c.cleaner_name, color: c.cleaner_color }) : h('span.avatar', { style: { background: '#C7C7CC' } }, '?'),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontWeight: 600 } }, c.cleaner_name || 'Не назначена'),
        h('div.small.muted', c.status === 'declined' ? 'отказалась' : c.cleaner_id ? 'уборщица' : 'выберите уборщицу')),
      c.status !== 'done' && h('button.btn.tinted.small', { onclick: () => assignSheet(c).then((ok) => ok && reload()) }, c.cleaner_id ? 'Сменить' : 'Назначить')),
    h('div', { style: { marginTop: '12px' } },
      c.start_time && kv('Выезд гостей / начало', c.start_time),
      c.end_time && kv('Заезд новых гостей', c.end_time),
      c.next_checkin && c.next_checkin !== c.date && kv('Следующий заезд', shortDate(c.next_checkin)),
      (chief || mine) && kv('Оплата', money(c.pay_amount)),
      c.started_at && kv('Начата', `${shortDate(c.started_at)}, ${timeOf(c.started_at)}`),
      c.finished_at && kv('Завершена', `${shortDate(c.finished_at)}, ${timeOf(c.finished_at)}`),
      c.inspection && kv('Осмотр после гостей', c.inspection === 'ok'
        ? `всё в порядке · ${timeOf(c.inspection_at)}`
        : h('span', { style: { color: 'var(--red)' } }, `найдены проблемы · ${timeOf(c.inspection_at)}`)),
      !c.inspection && c.status === 'done' && kv('Осмотр после гостей', 'не проводился'),
      chief && c.payout_id && kv('Выплата', 'выплачено')),
    c.note && h('div.note-box', { style: { marginTop: '12px' } }, c.note),
    c.access && !['done', 'cancelled'].includes(c.status) && h('div', { style: { marginTop: '12px' } },
      accessBox(c.access, chief ? 'Уборщица увидит это только в день уборки, после того как примет её' : null)),
    !c.access && c.access_exists && mine && ['assigned', 'accepted'].includes(c.status) && h('div.small.muted', { style: { marginTop: '12px' } },
      icon('key'), ' Код доступа появится здесь в день уборки', c.status === 'assigned' ? ', после того как вы её примете' : ''),
    chief && c.suggested && h('div.note-box', { style: { marginTop: '12px' } }, `Свободна в этот день: ${c.suggested.name}`),
    c.status === 'declined' && h('div.note-box.warn', { style: { marginTop: '12px' } },
      `${mine ? 'Вы отказались' : `${c.cleaner_name} отказалась`}${c.decline_reason ? ': ' + c.decline_reason : ''}`));

  // ---------- действия ----------
  let actions = null;
  if (mine && c.status === 'assigned') {
    actions = h('div.btn-row',
      h('button.btn.plain', { onclick: (e) => declineFlow(e.currentTarget, c) }, 'Не смогу'),
      h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => { await post(`/cleanings/${c.id}/accept`); refreshSummary(); reload(); }, 'Уборка принята') }, 'Принять'));
  } else if (mine && c.status === 'declined') {
    actions = h('button.btn.tinted.block', { onclick: (e) => act(e.currentTarget, async () => { await post(`/cleanings/${c.id}/accept`); reload(); }, 'Уборка снова ваша') }, 'Всё-таки смогу');
  } else if (mine && c.status === 'accepted') {
    actions = h('div.stack',
      h('button.btn.primary.block', {
        onclick: (e) => act(e.currentTarget, async () => { await post(`/cleanings/${c.id}/start`); reload(); }, 'Уборка начата — отмечайте пункты'),
      }, icon('play'), 'Начать уборку'),
      h('button.btn.plain.block', { onclick: (e) => declineFlow(e.currentTarget, c) }, 'Не смогу прийти'));
  }

  // ---------- чек-лист ----------
  const counter = h('span.small.muted');
  const bar = progressBar(0, 1);
  let done = c.checklist.filter((i) => i.done).length;
  const total = c.checklist.length;
  const finishBtn = h('button.btn.primary.block', { onclick: finish }, icon('check'), 'Завершить уборку');
  const finishHint = h('div.small.muted', { style: { textAlign: 'center', marginTop: '10px' } });
  const updateProgress = () => {
    counter.textContent = `${done} из ${total}`;
    bar.firstChild.style.width = `${total ? (done / total) * 100 : 0}%`;
    bar.classList.toggle('green', done === total);
    finishHint.textContent = done < total ? `Осталось отметить ${total - done} ${plural(total - done, 'пункт', 'пункта', 'пунктов')}` : 'Всё готово! Не забудьте видео-отчёт';
  };

  const sections = [];
  for (const item of c.checklist) {
    let s = sections.at(-1);
    if (!s || s.name !== item.section) sections.push((s = { name: item.section, items: [] }));
    s.items.push(item);
  }
  // фото к пункту: камера → сжатие → загрузка → пункт отмечается сам
  const takePhoto = (item, el) => {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      el.classList.add('uploading');
      try {
        const form = new FormData();
        form.append('photo', await compressImage(file));
        const { id: mediaId } = await upload(`/checklist/${item.id}/photo`, form);
        if (!item.done) { item.done = 1; done += 1; updateProgress(); }
        item.photos.push(mediaId);
        el.replaceWith(checkEl(item));
        toast('Фото добавлено');
      } catch (e) {
        el.classList.remove('uploading');
        toast(e.message, true);
      }
    });
    input.click();
  };

  const checkEl = (item) => {
    const el = h('div.check', { class: [item.done ? 'done' : '', canCheck ? '' : 'readonly'].join(' ') },
      h('span.box', icon('check')),
      h('div.check-body',
        h('span.check-text', item.text),
        !!item.photo_required && !item.photos.length && h('span.photo-tag', icon('camera'), item.done ? 'без фото' : 'нужно фото'),
        item.photos.length > 0 && h('div.check-photos', item.photos.map((pid) =>
          h('a', { href: `/media/${pid}`, target: '_blank', onclick: (e) => e.stopPropagation() }, h('img', { src: `/media/${pid}`, loading: 'lazy', alt: '' }))))),
      canCheck && !!item.photo_required && h('button.icon-btn.check-cam', {
        'aria-label': 'Сфотографировать',
        onclick: (e) => { e.stopPropagation(); takePhoto(item, el); },
      }, icon('camera')));
    if (canCheck) {
      el.addEventListener('click', async () => {
        if (item.photo_required && !item.done && !item.photos.length) return takePhoto(item, el);
        const was = !!item.done;
        item.done = was ? 0 : 1;
        el.classList.toggle('done', !was);
        done += was ? -1 : 1;
        updateProgress();
        if (!was && navigator.vibrate) navigator.vibrate(8);
        try { await post(`/checklist/${item.id}/toggle`); }
        catch (e) { item.done = was ? 1 : 0; el.classList.toggle('done', was); done += was ? 1 : -1; updateProgress(); toast(e.message, true); }
      });
    }
    return el;
  };

  // осмотр после гостей — до уборки, чтобы было чем подтвердить претензию к гостю
  const inspection = needInspection && h('div.section', h('div.card',
    h('div.meta', { style: { marginBottom: '8px' } }, h('span.pill.accent', 'Шаг 1'), h('span.small.muted', 'до начала уборки')),
    h('div', { style: { fontSize: '20px', fontWeight: 700 } }, 'Осмотр после гостей'),
    h('div.small.muted', { style: { margin: '6px 0 16px', lineHeight: 1.45 } },
      'Пройдитесь по квартире до уборки: нет ли поломок, пятен, разбитой посуды, забытых вещей. '
      + 'Если что-то нашли — сфотографируйте: так можно предъявить претензию гостю.'),
    h('div.btn-row',
      h('button.btn.danger', {
        onclick: async () => {
          if (!(await problemSheet({ cleaningId: c.id }))) return;
          await act(null, () => post(`/cleanings/${c.id}/inspection`, { result: 'issues' }));
          reload();
        },
      }, 'Есть проблема'),
      h('button.btn.primary', {
        onclick: (e) => act(e.currentTarget, async () => { await post(`/cleanings/${c.id}/inspection`, { result: 'ok' }); reload(); }, 'Отлично, можно убирать'),
      }, 'Всё в порядке'))));
  updateProgress();

  const checklist = section('Чек-лист', counter,
    h('div', { style: { margin: '0 4px 14px' } }, bar),
    mine && ['assigned', 'accepted'].includes(c.status) && h('div.note-box', { style: { marginBottom: '14px' } }, 'Нажмите «Начать уборку», чтобы отмечать пункты.'),
    needInspection && h('div.note-box', { style: { marginBottom: '14px' } }, 'Сначала осмотрите квартиру (шаг 1 выше) — потом можно отмечать пункты.'),
    canCheck && c.checklist.some((i) => i.photo_required) && h('div.section-foot', { style: { margin: '-6px 4px 12px' } },
      'Пункты с камерой отмечаются фотографией результата — нажмите на пункт, откроется камера.'),
    c.status === 'done' && done < total && h('div.note-box.warn', { style: { marginBottom: '14px' } },
      h('b', `Не выполнено: ${total - done} ${plural(total - done, 'пункт', 'пункта', 'пунктов')}`),
      h('div.small', { style: { marginTop: '4px' } }, c.checklist.filter((i) => !i.done).map((i) => `• ${i.text}`).join('\n'))),
    sections.map((s, i) => h('div', { style: { marginTop: i ? '18px' : 0 } },
      h('div.section-caption', s.name),
      h('div.group', s.items.map(checkEl)))));

  // ---------- отчёт ----------
  const videos = c.media.filter((m) => m.kind === 'video');
  const photos = c.media.filter((m) => m.kind === 'photo' && !m.item_id);
  const comment = h('textarea.textarea', { rows: 3, placeholder: 'Как прошла уборка? Что заметили?' }, c.comment || '');
  if (canReport) {
    comment.addEventListener('change', () => post(`/cleanings/${c.id}/comment`, { comment: comment.value }).then(() => toast('Комментарий сохранён')).catch((e) => toast(e.message, true)));
  }
  const prog = progressBlock();
  const fileInput = h('input.hidden', { type: 'file', accept: 'video/*,image/*', multiple: true });
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    uploadBtn.disabled = true;
    const release = await keepAwake();
    const saved = [];
    try {
      for (const [i, original] of files.entries()) {
        const prefix = files.length > 1 ? `Файл ${i + 1} из ${files.length} · ` : '';
        let f = original;
        if (original.type.startsWith('video/')) {
          // сначала сжимаем на телефоне; «Отправить без сжатия» — если устройство справляется медленно
          const signal = {};
          skipBtn.onclick = () => signal.cancel?.();
          skipBtn.classList.toggle('hidden', !canCompressVideo());
          prog.set(`${prefix}Подготовка видео…`, 0);
          const r = await compressVideo(original, { signal, onProgress: (p) => prog.set(`${prefix}Сжатие видео`, p) });
          skipBtn.classList.add('hidden');
          f = r.file;
          if (r.compressed) saved.push(`${fileSize(r.originalSize)} → ${fileSize(f.size)}${r.audioDropped ? ', без звука' : ''}`);
        } else if (original.type.startsWith('image/')) {
          f = await compressImage(original);
        }
        const form = new FormData();
        form.append('files', f);
        await upload(`/cleanings/${c.id}/media`, form, (p, loaded, totalB) =>
          prog.set(`${prefix}Загрузка ${fileSize(loaded)} из ${fileSize(totalB)}`, p));
      }
      toast(saved.length ? `Загружено. Видео сжато: ${saved.join('; ')}` : 'Загружено');
      reload();
    } catch (e) {
      toast(e.message, true);
      prog.hide();
    } finally {
      release();
      skipBtn.classList.add('hidden');
      uploadBtn.disabled = false;
      fileInput.value = '';
    }
  });
  const skipBtn = h('button.btn.plain.small.hidden', { style: { marginTop: '10px' } }, 'Отправить без сжатия');
  const uploadBtn = h('button.btn.tinted.block', { onclick: () => fileInput.click() }, icon('video'), videos.length ? 'Добавить ещё видео' : 'Загрузить видео-отчёт');

  const showReport = canReport || c.media.length || c.comment || (chief && c.status === 'done');
  const report = showReport && section('Отчёт', videos.length ? h('span.small.muted', `${videos.length} видео`) : null,
    h('div.stack',
      videos.map((m) => h('div',
        m.expired
          ? h('div.card.small.muted', { style: { textAlign: 'center' } }, icon('video'), h('div', 'Видео удалено автоматически (срок хранения истёк)'))
          : h('div.video-wrap', h('video', { src: `/media/${m.id}`, controls: true, preload: 'metadata', playsinline: true })),
        h('div.media-meta',
          h('span', `${m.uploaded_by_name || ''} · ${ago(m.created_at)}${m.size ? ' · ' + fileSize(m.size) : ''}`),
          (chief || m.uploaded_by === state.me.id) && !m.expired && h('button', { style: { color: 'var(--red)', fontSize: '13px' }, onclick: () => removeMedia(m) }, 'Удалить')))),
      photos.length > 0 && h('div.thumbs', photos.map((m) => h('a', { href: `/media/${m.id}`, target: '_blank' }, h('img', { src: `/media/${m.id}`, loading: 'lazy', alt: '' })))),
      !videos.length && !canReport && h('div.card.small.muted', { style: { textAlign: 'center' } }, 'Видео не прикреплено'),
      canReport && h('div', fileInput, uploadBtn, prog.el, skipBtn,
        h('div.section-foot', { style: { margin: '8px 4px 0' } },
          'Снимите все комнаты одним видео: 1–3 минуты. Перед отправкой видео сжимается на телефоне — не закрывайте экран, пока идёт загрузка.')),
      canReport
        ? h('div', { style: { marginTop: '6px' } }, h('div.section-caption', { style: { margin: '10px 4px 7px' } }, 'Комментарий'), comment)
        : c.comment && h('div.card', h('div.small.muted', { style: { marginBottom: '6px' } }, 'Комментарий уборщицы'), h('div.pre', c.comment))));

  const finishBlock = working && h('div.section', h('div.card', finishBtn, finishHint));

  // оценка шефа: шеф ставит звёзды, уборщица видит свою оценку
  const rating = c.status === 'done' && (chief || c.rating) && section('Оценка', null, h('div.card',
    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
    h('div.small.muted', chief ? (c.rating ? 'Можно изменить' : 'Уборщица увидит оценку') : 'Оценка шефа'),
    ratingStars(c.rating, chief ? (n) => post(`/cleanings/${c.id}/rating`, { rating: n }).then(() => toast('Оценка сохранена')) : null)));

  async function finish() {
    const missed = total - done;
    const warnings = [
      missed && `Не отмечено ${missed} ${plural(missed, 'пункт', 'пункта', 'пунктов')} чек-листа — шеф это увидит.`,
      !videos.length && 'Видео-отчёт не загружен.',
    ].filter(Boolean);
    if (warnings.length && !(await confirmAction('Завершить уборку?', 'Завершить всё равно', { message: warnings.join(' ') }))) return;
    await act(finishBtn, async () => {
      await post(`/cleanings/${c.id}/finish`, { comment: comment.value });
      reload();
    }, 'Уборка завершена. Спасибо!');
  }

  async function removeMedia(m) {
    if (!(await confirmAction('Удалить видео?', 'Удалить', { destructive: true }))) return;
    await act(null, async () => { await api(`/media/${m.id}`, { method: 'DELETE' }); reload(); }, 'Удалено');
  }

  // ---------- проблемы и покупки по этой уборке ----------
  const canAdd = chief || mine;
  const problems = (c.problems.length || canAdd) && section('Проблемы', null,
    c.problems.length > 0 && h('div.group', { style: { marginBottom: '10px' } }, c.problems.map((p) => row({
      left: h('span.row-icon', { style: { background: `var(--${PROBLEM_KIND[p.kind][1]})` } }, icon(p.kind === 'forgotten' ? 'box' : 'alert')),
      title: p.description,
      sub: `${PROBLEM_KIND[p.kind][0]} · ${p.author} · ${p.status === 'open' ? 'открыта' : 'решена'}`,
      chevron: true,
      onclick: () => (location.hash = '#/problems'),
    }))),
    canAdd && c.status !== 'cancelled' && h('div.btn-row',
      h('button.btn.plain', { onclick: () => problemSheet({ cleaningId: c.id }).then((ok) => ok && reload()) }, icon('alert'), 'Проблема'),
      h('button.btn.plain', { onclick: () => addPurchaseSheet({ cleaningId: c.id }).then((ok) => ok && reload()) }, icon('cart'), 'Докупить')));

  const purchases = c.purchases.length > 0 && section('Докупить', h('a.section-link', { href: '#/purchases' }, 'Весь список'),
    h('div.group', c.purchases.map((p) => row({
      icon: 'cart', iconBg: p.status === 'bought' ? 'var(--green)' : 'var(--accent)',
      title: p.title, sub: p.status === 'bought' ? 'куплено' : `добавила ${p.author}`,
    }))));

  // ---------- меню шефа ----------
  const menuBtn = chief && h('button.icon-btn', {
    'aria-label': 'Действия',
    onclick: async () => {
      const opts = [{ text: 'Изменить', value: 'edit' }];
      if (!['done', 'cancelled'].includes(c.status)) opts.push({ text: 'Отменить уборку', value: 'cancel', destructive: true });
      if (c.status === 'cancelled') opts.push({ text: 'Восстановить', value: 'restore' });
      if (!c.payout_id) opts.push({ text: 'Удалить навсегда', value: 'delete', destructive: true });
      const v = await actionSheet({ title: `${TYPE[c.type]} уборка · ${dayLabel(c.date)}`, actions: opts });
      if (v === 'edit') { if (await cleaningEditor({ cleaning: c })) reload(); }
      if (v === 'restore') { await act(null, () => api(`/cleanings/${c.id}`, { method: 'PATCH', body: {} }), 'Восстановлено'); reload(); }
      if (v === 'cancel' && await confirmAction('Отменить уборку?', 'Отменить уборку', { destructive: true, message: c.cleaner_id ? `${c.cleaner_name} получит уведомление` : '' })) {
        await act(null, () => post(`/cleanings/${c.id}/cancel`), 'Уборка отменена'); reload();
      }
      if (v === 'delete' && await confirmAction('Удалить уборку?', 'Удалить', { destructive: true, message: 'Отчёт и видео тоже удалятся' })) {
        await act(null, () => api(`/cleanings/${c.id}`, { method: 'DELETE' }), 'Удалено');
        history.back();
      }
    },
  }, icon('more'));

  return {
    title: `${TYPE[c.type]} уборка`,
    back: '#/calendar',
    large: false,
    actions: [menuBtn],
    content: [
      header,
      actions && h('div.section', actions),
      inspection,
      checklist,
      report,
      finishBlock,
      rating,
      problems,
      purchases,
    ],
  };
}

const kv = (k, v) => h('div.kv', h('span.k', k), h('span.v', v));
