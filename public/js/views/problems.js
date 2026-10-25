import {
  h, icon, api, post, isChief, clear, segmented, emptyState, ago, shortDate, act, sheet, field, toast,
} from '../core.js';
import { problemSheet } from './shared.js';
import { refreshSummary } from '../app.js';

const KIND = { breakage: ['Поломка', 'red', 'wrench'], forgotten: ['Гости забыли', 'blue', 'box'], other: ['Другое', 'gray', 'info'] };
let tab = 'open';

export async function problemsView() {
  const listEl = h('div');

  async function load() {
    const items = await api(`/problems?status=${tab}`);
    clear(listEl, items.length
      ? items.map(card)
      : h('div.card', emptyState(tab === 'open' ? 'check' : 'alert', tab === 'open' ? 'Открытых проблем нет' : 'Решённых пока нет')));
  }

  function card(p) {
    const [label, color, ic] = KIND[p.kind];
    const photos = p.media.filter((m) => m.kind === 'photo');
    return h('div.card',
      h('div.meta', { style: { justifyContent: 'space-between', marginBottom: '10px' } },
        h('span.pill', { class: color }, icon(ic), label),
        h('span.small.muted', ago(p.created_at))),
      h('div.pre', p.description),
      photos.length > 0 && h('div.thumbs', photos.map((m) => h('a', { href: `/media/${m.id}`, target: '_blank' }, h('img', { src: `/media/${m.id}`, loading: 'lazy', alt: '' })))),
      h('div.small.muted', { style: { marginTop: '10px' } },
        p.author,
        p.cleaning_id && [' · ', h('a', { href: `#/cleaning/${p.cleaning_id}` }, `уборка ${shortDate(p.cleaning_date)}`)]),
      p.status === 'resolved' && h('div.note-box', { style: { marginTop: '12px', background: 'rgba(36,138,61,.08)' } },
        h('b', 'Решено'), p.resolution ? `: ${p.resolution}` : '', h('div.small.muted', ago(p.resolved_at))),
      isChief() && h('div', { style: { marginTop: '14px' } },
        p.status === 'open'
          ? h('button.btn.tinted.block', { onclick: () => resolve(p) }, icon('check'), 'Отметить решённой')
          : h('button.btn.plain.block', { onclick: (e) => act(e.currentTarget, async () => { await post(`/problems/${p.id}/reopen`); refreshSummary(); load(); }, 'Проблема снова открыта') }, 'Открыть снова')));
  }

  async function resolve(p) {
    const text = h('textarea.textarea', { rows: 3, placeholder: p.kind === 'forgotten' ? 'Например: отдали гостю курьером' : 'Например: вызвали мастера, починили' });
    const ok = await sheet({
      title: 'Решение',
      doneText: 'Готово',
      build: () => field('Что сделали (необязательно)', text),
      onDone: () => post(`/problems/${p.id}/resolve`, { resolution: text.value }),
    });
    if (ok) { toast('Проблема решена'); refreshSummary(); load(); }
  }

  await load();
  return {
    title: 'Проблемы',
    subtitle: 'Поломки, забытые гостями вещи и всё необычное',
    back: isChief() ? null : '#/profile',
    actions: [h('button.icon-btn', { onclick: () => problemSheet().then((ok) => ok && load()), 'aria-label': 'Сообщить' }, icon('plus'))],
    content: [
      segmented([['open', 'Открытые'], ['resolved', 'Решённые']], tab, (v) => { tab = v; load(); }),
      listEl,
    ],
  };
}
