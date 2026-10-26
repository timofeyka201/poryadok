import { h, api, clear, segmented, emptyState, avatar, plural, shortDate } from '../core.js';

const st = { days: 30 };

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
function duration(min) {
  if (min == null) return '—';
  const hrs = Math.floor(min / 60);
  return hrs ? `${hrs} ч ${String(min % 60).padStart(2, '0')} мин` : `${min} мин`;
}

/** Статистика по уборщицам за период: скорость, полнота чек-листа, опоздания, оценки. */
export async function statsView() {
  const body = h('div');

  async function load() {
    const data = await api(`/stats?days=${st.days}`);
    clear(body, data.people.length
      ? data.people.map(card)
      : h('div.card', emptyState('chart', 'Пока нет уборщиц')),
    h('div.section-foot', { style: { margin: '14px 4px 0', lineHeight: 1.45 } },
      st.days ? `Завершённые уборки с ${shortDate(data.from)}. ` : 'Все завершённые уборки. ',
      'Длительность — от «Начать» до «Завершить». Опоздание — начала позже запланированного времени больше чем на 15 минут.'));
  }

  const tile = (value, label, sub) => h('div.stat', h('div.stat-value', value, sub && h('small', ` ${sub}`)), h('div.stat-label', label));

  function card(p) {
    const none = !p.count;
    return h('div.card',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
        avatar(p),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: 600 } }, p.name, !p.active && h('span.small.muted', ' · отключена')),
          h('div.small.muted', none ? 'Нет завершённых уборок за период' : `${p.count} ${plural(p.count, 'уборка', 'уборки', 'уборок')}`))),
      !none && h('div.stat-grid',
        tile(duration(p.avg_minutes), 'Средняя длительность'),
        tile(pct(p.full_checklist), 'Чек-лист выполнен полностью'),
        tile(p.timed ? `${p.late}` : '—', 'Опоздания', p.timed ? `из ${p.timed}` : ''),
        tile(p.avg_rating == null ? '—' : `${p.avg_rating.toFixed(1).replace('.', ',')} ★`,
          p.rated ? `Средняя оценка · ${p.rated} ${plural(p.rated, 'оценка', 'оценки', 'оценок')}` : 'Средняя оценка'),
        tile(pct(p.with_video), 'С видео-отчётом'),
        tile(`${p.declines}`, 'Отказов от уборок')));
  }

  await load();
  return {
    title: 'Статистика',
    back: '#/more',
    large: true,
    content: [
      segmented([[30, '30 дней'], [90, '90 дней'], [0, 'Всё время']], st.days, (v) => { st.days = v; load(); }),
      body,
    ],
  };
}
