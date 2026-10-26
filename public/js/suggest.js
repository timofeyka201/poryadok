// Подсказки при вводе покупки: понимают опечатки, регистр, ё/е, синонимы
// и текст, набранный в английской раскладке («nefktnyfz» → «туалетная»).
import { h, icon, clear } from './core.js';

// label — как пункт попадёт в список; keys — как его могут назвать
export const CATALOG = [
  { label: 'Туалетная бумага', keys: ['туалетная бумага', 'бумага туалетная', 'туалетка', 'туалетную бумагу'] },
  { label: 'Зубные щётки', keys: ['зубные щётки', 'зубная щётка', 'щётки зубные', 'щетки'] },
  { label: 'Гель для душа', keys: ['гель для душа', 'гель душ', 'душ гель'] },
  { label: 'Шампунь', keys: ['шампунь', 'шампуни'] },
  { label: 'Мусорные пакеты', keys: ['мусорные пакеты', 'пакеты для мусора', 'мешки для мусора', 'мусорные мешки', 'пакеты мусорные'] },
  { label: 'Салфетки', keys: ['салфетки', 'бумажные салфетки', 'влажные салфетки'] },
  { label: 'Средство для посуды', keys: ['средство для посуды', 'гель для посуды', 'моющее для посуды', 'фейри', 'fairy'] },
  { label: 'Средство для стирки', keys: ['средство для стирки', 'гель для стирки', 'стиральный порошок', 'порошок', 'капсулы для стирки'] },
  { label: 'Антижир', keys: ['антижир', 'анти жир', 'обезжириватель', 'от жира', 'шуманит'] },
  { label: 'Средство для туалета', keys: ['средство для туалета', 'утёнок', 'туалетный утёнок', 'гель для туалета', 'спрей для туалета', 'гель для унитаза', 'доместос', 'domestos'] },
  { label: 'Средство для раковины', keys: ['средство для раковины', 'блеск для раковины', 'гель для раковины', 'спрей для раковины'] },
  { label: 'Одноразовые тряпки', keys: ['одноразовые тряпки', 'тряпки', 'тряпки одноразовые', 'салфетки для уборки'] },
  { label: 'Освежитель воздуха для туалета', keys: ['освежитель воздуха', 'освежитель для туалета', 'дезодорант для туалета', 'освежитель'] },
  { label: 'Мыло', keys: ['мыло', 'кусковое мыло'] },
  { label: 'Жидкое мыло для рук', keys: ['мыло для рук', 'гель для рук', 'жидкое мыло'] },
];

const EN = 'qwertyuiop[]asdfghjkl;\'zxcvbnm,.`';
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';

export function normalize(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Текст, набранный в английской раскладке, переводим в русскую: «ifvgeym» → «шампунь». */
function fromEnLayout(s) {
  return [...s.toLowerCase()].map((ch) => { const i = EN.indexOf(ch); return i >= 0 ? RU[i] : ch; }).join('');
}

/** Расстояние Дамерау — Левенштейна: сколько правок отделяет одно слово от другого. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Допустимое число опечаток растёт с длиной слова
const allowed = (len) => (len <= 3 ? 0 : len <= 5 ? 1 : 2);

/** Насколько слово запроса похоже на начало слова из каталога (0 — не похоже). */
function wordScore(q, w) {
  if (w.startsWith(q)) return 3;
  const max = allowed(q.length);
  if (!max) return 0;
  let best = Infinity;
  for (const len of [q.length - 1, q.length, q.length + 1]) {
    if (len > 0 && len <= w.length) best = Math.min(best, distance(q, w.slice(0, len)));
  }
  if (q.length >= w.length - 1) best = Math.min(best, distance(q, w));
  return best <= max ? 2 - best / (max + 1) : 0;
}

/** Каждое слово запроса должно найтись среди слов ключа (в любом порядке). */
function keyScore(qWords, key) {
  const words = key.split(' ');
  let total = 0;
  for (const [i, q] of qWords.entries()) {
    let best = 0;
    for (const [j, w] of words.entries()) best = Math.max(best, wordScore(q, w) - (j && i === 0 ? 0.3 : 0));
    if (!best) return 0;
    total += best;
  }
  return total / qWords.length;
}

export function suggest(query, limit = 4) {
  const tries = [normalize(query)];
  if (/^[a-z\s;',.[\]`]+$/i.test(query.trim())) tries.push(normalize(fromEnLayout(query)));
  const results = new Map();
  for (const q of tries) {
    if (q.length < 2) continue;
    const qWords = q.split(' ');
    for (const item of CATALOG) {
      if (normalize(item.label) === q) continue;
      const score = Math.max(...item.keys.map((k) => keyScore(qWords, normalize(k))));
      if (score > (results.get(item) ?? 0)) results.set(item, score);
    }
  }
  return [...results.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([item]) => item.label);
}

/**
 * Подключает подсказки к полю ввода. Список появляется под полем;
 * onPick(label) вызывается при выборе (по умолчанию — подставить текст в поле).
 */
export function attachSuggest(input, { onPick } = {}) {
  const box = h('div.suggest.hidden');
  const update = () => {
    const items = suggest(input.value);
    box.classList.toggle('hidden', !items.length);
    clear(box, items.map((label) => h('button', {
      type: 'button',
      // pointerdown, чтобы клавиатура на телефоне не закрылась раньше выбора
      onpointerdown: (e) => { e.preventDefault(); pick(label); },
    }, icon('cart'), label)));
  };
  const pick = (label) => {
    input.value = label;
    box.classList.add('hidden');
    if (onPick) onPick(label); else input.focus();
  };
  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => setTimeout(() => box.classList.add('hidden'), 150));
  input.setAttribute('autocomplete', 'off');
  return box;
}
