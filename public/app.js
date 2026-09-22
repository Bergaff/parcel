/* попутка. клиентская часть. Без фреймворков, без сборки. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  type: '',
  archive: false,
  from: '',
  to: '',
  date: '',
  page: 1,
  hasMore: false,
  total: 0,
};

let config = { siteName: 'попутка.', botUsername: null, botLink: null };

/* Адрес API воркера задаётся в index.html (window.POPUTKA_API_BASE) до загрузки app.js:
   пустая строка = API на том же домене, иначе — полный адрес воркера. */
const API_BASE = (window.POPUTKA_API_BASE || '').replace(/\/+$/, '');

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  return res;
}

/* ---------- мелкие помощники ---------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 3600);
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
// «17 сентября 2026» — тот же вид, что печатает сервер (MONTHS_GEN в src/format.ts)
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function fmtFullDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

/** «только что» → «15 сен». Считаем по МСК, как agoText() на сервере: первые
 *  строки доски рисует SSR, потом их же перерисовывает клиент — при разных
 *  правилах текст под заголовком менялся бы на глазах (и «сегодня» у
 *  пользователя в другом часовом поясе не совпадало бы с архивом). */
function ago(iso) {
  const MSK = 3 * 3600 * 1000;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const d = new Date(t + MSK);
  const n = new Date(Date.now() + MSK);
  const day = `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
  const s = Math.floor((n - d) / 1000);
  if (s < 0) return day;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400 && d.getUTCDate() === n.getUTCDate()) return `сегодня в ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (s < 172800) return 'вчера';
  return day;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* Контакт заявки: kind — 'telegram' или 'phone'.
 * Значения проверяем по содержимому, а не по имени поля: номер, который попал
 * в поле telegram, не должен превращаться в несуществующую ссылку t.me/+48579264254,
 * а один и тот же контакт — показываться дважды. */
function contactInfo(l) {
  const values = [l.telegram, l.phone].filter((v) => typeof v === 'string' && v.trim());
  for (const v of values) {
    const t = v.trim();
    const m = /(?:t\.me\/|@)([a-zA-Z0-9_]{4,32})/i.exec(t)
      || (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(t) ? [t, t] : null);
    if (m) return { kind: 'telegram', href: `https://t.me/${m[1]}`, label: `@${m[1]}` };
  }
  for (const v of values) {
    const m = /\+?\d[\d\s\-()]{7,16}\d/.exec(v);
    if (m && m[0].replace(/\D/g, '').length >= 9) {
      return { kind: 'phone', href: `tel:${m[0].replace(/[^\d+]/g, '')}`, label: m[0].trim() };
    }
  }
  return null;
}

/* Чем разобран текст (правилами или ИИ) — внутренняя деталь, на сайте её не видно.
   Показываем только откуда объявление: чат, пересылка или форма на сайте. */
function sourceLabel(l) {
  if (l.sourceChat && l.sourceChat.startsWith('Переслано от ')) return l.sourceChat;
  if (l.source === 'parser' || l.source === 'telegram') {
    return l.sourceChat ? `из чата «${l.sourceChat}»` : 'из Telegram';
  }
  return 'с сайта';
}

/* Ссылка на исходное сообщение: t.me/c/… — для супергрупп и каналов (id -100…),
 * открывается у участников чата. Пересылки от людей и обычные группы — без ссылки. */
function sourceLinkUrl(l) {
  if (!l.sourceChatId) return null;
  if (chatLinks[l.sourceChatId]) return chatLinks[l.sourceChatId]; // ссылка, заданная админом
  const m = /^-100(\d+)$/.exec(l.sourceChatId);
  if (!m) return null;
  return `https://t.me/c/${m[1]}${l.sourceMessageId != null ? '/' + l.sourceMessageId : ''}`;
}

/* Подпись источника — кликабельная, когда есть ссылка на оригинал */
function sourceContent(l) {
  const url = sourceLinkUrl(l);
  if (!url) return sourceLabel(l);
  return el('a', { href: url, target: '_blank', rel: 'noopener', text: sourceLabel(l) });
}

/* ---------- скопировать ссылку на объявление ---------- */

/* Ссылка ведёт на воркер: там /item/:id отдаёт страницу с OG-разметкой,
   поэтому в мессенджерах появляется превью с маршрутом и описанием. */
function shareUrlFor(l) {
  // Делимся всегда главным доменом — с какого бы адреса ни открыли доску
  return `https://pop-utka.app/item/${l.id}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* попробуем резервный способ */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyListingLink(l) {
  const url = shareUrlFor(l);
  const ok = await copyToClipboard(url);
  if (ok) {
    toast('Ссылка скопирована — вставьте в любой чат.');
    return;
  }
  // последний шанс: показать ссылку в окне, откуда её можно скопировать руками
  window.prompt('Скопируйте ссылку:', url);
}

/* ---------- роутинг ---------- */

function showView(name) {
  for (const v of VIEWS) {
    $(`#view-${v}`).hidden = v !== name;
  }
  const navOn = name === 'how' ? '/how' : name === 'bot' ? '/bot' : name === 'list' || name === 'item' ? '/' : null;
  $$('.topnav a').forEach((a) => {
    a.classList.toggle('on', a.getAttribute('href') === navOn);
  });
  const titles = {
    list: 'попутка. доска попутных передач',
    how: 'попутка. как это работает',
    bot: 'попутка. телеграм-бот',
    terms: 'попутка. условия использования',
    privacy: 'попутка. политика приватности',
    new: 'попутка. новое объявление',
    item: 'попутка. объявление',
    admin: 'попутка. админ',
  };
  // На первой странице заголовок уже поставил воркер (он полнее и нужен поиску) —
  // не затираем его, свои короткие ставим только при переходах внутри сайта
  if (!window.__SSR__ || !initialRoute) document.title = titles[name] ?? titles.list;
  window.scrollTo({ top: 0 });
}

/* Нормальные адреса вместо #/…: для поисковика всё после «#» — не URL, поэтому
   страницы «как это работает», «условия», «приватность» и карточки объявлений
   в индексе не существовали. Старые хеш-ссылки (их много в Telegram) на лету
   превращаются в пути — без перезагрузки и без потери контента. */

const VIEWS = ['list', 'item', 'new', 'how', 'bot', 'terms', 'privacy', 'admin'];
const APP_PATHS = ['/', '/new', '/how', '/bot', '/terms', '/privacy', '/admin'];

function isAppPath(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  return APP_PATHS.includes(p) || p.startsWith('/item/');
}

function parsePath(pathname = location.pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  const m = /^\/item\/([^/]+)$/.exec(p);
  if (m) return { view: 'item', id: decodeURIComponent(m[1]) };
  const bare = p.slice(1);
  if (['new', 'how', 'bot', 'terms', 'privacy', 'admin'].includes(bare)) return { view: bare };
  return { view: 'list' };
}

/** '#/item/x' → '/item/x', '#/how' → '/how', '#/' → '/' */
function hashToPath(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '').replace(/^\/+/, '');
  return raw ? `/${raw}` : '/';
}

function readFilters() {
  const q = new URLSearchParams(location.search);
  return {
    from: q.get('from') || '',
    to: q.get('to') || '',
    date: q.get('date') || '',
    type: q.get('type') || '',
    archive: q.get('archive') === '1',
  };
}

/** Фильтры доски — в адрес (replaceState: история не засоряется, ссылкой можно поделиться). */
function syncFiltersToUrl() {
  const q = new URLSearchParams();
  if (state.from) q.set('from', state.from);
  if (state.to) q.set('to', state.to);
  if (state.date) q.set('date', state.date);
  if (state.type) q.set('type', state.type);
  if (state.archive) q.set('archive', '1');
  const search = q.toString();
  const url = `/${search ? `?${search}` : ''}`;
  if (url !== location.pathname + location.search) history.replaceState(null, '', url);
}

function navTo(url, opts = {}) {
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  route();
}

let initialRoute = true; // первый route() работает по HTML, который прислал воркер

async function route() {
  // старая хеш-ссылка в адресе — сразу превращаем её в путь
  if (location.hash && location.hash !== '#') {
    const path = hashToPath(location.hash);
    history.replaceState(null, '', path === '/' ? `/${location.search}` : path);
  }
  const r = parsePath();
  if (r.view === 'new') showView('new');
  else if (r.view === 'how') showView('how');
  else if (r.view === 'bot') showView('bot');
  else if (r.view === 'terms') showView('terms');
  else if (r.view === 'privacy') showView('privacy');
  else if (r.view === 'admin') { showView('admin'); await loadAdmin(); }
  else if (r.view === 'item') { showView('item'); await loadDetail(r.id); }
  else {
    showView('list');
    Object.assign(state, readFilters());
    $('#f-from').value = state.from;
    $('#f-to').value = state.to;
    $('#f-date').value = state.date;
    $$('.tab').forEach((t) => {
      t.classList.toggle('on', state.archive ? t.dataset.type === 'archive' : t.dataset.type === state.type);
    });
    await loadList(true);
  }
  initialRoute = false;
}

window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);

/* Клик по внутренней ссылке — переход без перезагрузки, но href настоящий:
   работают средняя кнопка, «открыть в новой вкладке» и краулеры. Служебные
   страницы (/r/…, /routes, /gorod/…, /itogi) грузятся обычным переходом.
   Здесь же — кнопки, нарисованные сервером (data-report / data-copy). */
document.addEventListener('click', (e) => {
  const hit = e.target.closest ? e.target.closest('[data-report], [data-copy], a[href]') : null;
  if (!hit) return;

  if (hit.dataset && hit.dataset.report) { e.preventDefault(); openReport(hit.dataset.report); return; }
  if (hit.dataset && hit.dataset.copy) {
    e.preventDefault();
    copyListingLink(listingCache.get(hit.dataset.copy) || { id: hit.dataset.copy });
    return;
  }

  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = hit.getAttribute('href');
  if (!href || href.startsWith('#')) return;
  let url;
  try { url = new URL(href, location.href); } catch { return; }
  if (url.origin !== location.origin || !isAppPath(url.pathname)) return;
  e.preventDefault();
  navTo(url.pathname + url.search);
});

/* ---------- доска ---------- */

function buildRow(l) {
  const contact = contactInfo(l);
  const row = el('article', { class: 'row' }, [
    // Растянутая ссылка: переход по клику делает браузер, без JS в критическом
    // пути (короче отклик — INP). Заодно работают средняя кнопка, «открыть в
    // новой вкладке» и Enter с клавиатуры. Запрос заранее не шлём: карточка и
    // так рисуется мгновенно из кэша, а GET карточки засчитывает просмотр.
    el('a', {
      class: 'row-link',
      href: `/item/${l.id}`,
      'aria-label': `${l.fromCity} → ${l.toCity}: открыть объявление`,
    }),
    el('div', { class: 'row-main' }, [
      el('h3', { class: 'route-line' }, [
        l.fromCity,
        el('span', { class: 'r-arrow', text: '→' }),
        el('span', { class: 'r-to', text: l.toCity }),
      ]),
      el('p', { class: 'desc', text: l.description }),
      el('div', { class: 'meta-line' }, [
        el('span', { text: ago(l.publishedAt || l.createdAt) }),
        l.recurring
          ? el('span', { text: `↻ ${l.recurring}${l.departureDate ? `, ближайший ${fmtDate(l.departureDate)}` : ''}` })
          : l.departureDate ? el('span', { text: `выезд ${fmtDate(l.departureDate)}` }) : el('span', { text: 'дата не указана' }),
        l.weightKg != null ? el('span', { class: 'mono', text: `${String(l.weightKg).replace('.', ',')} кг` }) : null,
        l.price ? el('span', { class: 'mono', text: l.price }) : null,
        el('span', { class: 'src' }, [sourceContent(l)]),
      ].filter(Boolean)),
    ]),
    el('div', { class: 'row-side' }, [
      el('span', { class: `stamp stamp-${l.type}`, text: l.type === 'offer' ? 'водитель везёт' : 'ищу передачу' }),
      l.recurring ? el('span', { class: 'stamp stamp-recur', text: 'регулярно' }) : null,
      // Регулярный рейс архивом не помечаем: дату катит cron (archiveExpired)
      (l.status === 'expired' || (l.departureDate && l.departureDate < mskTodayIso() && !l.recurring))
        ? el('span', { class: 'stamp stamp-expired', text: 'архив' })
        : null,
      contact
        ? el('a', { class: 'write-link', href: contact.href, target: '_blank', rel: 'noopener', text: contact.kind === 'phone' ? 'позвонить' : 'написать' })
        : el('span', { class: 'write-link', style: 'cursor:default', text: 'контакт в карточке' }),
      el('a', { class: 'write-link share-link', text: 'скопировать', onclick: (e) => { e.preventDefault(); e.stopPropagation(); copyListingLink(l); } }),
      el('a', {
        class: 'write-link report-link',
        href: `/item/${l.id}`,
        text: 'пожаловаться',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); openReport(l.id); },
      }),
      el('span', { class: 'row-no', text: `№ ${l.id.slice(0, 4).toUpperCase()}` }),
    ].filter(Boolean)),
  ]);

  return row;
}

async function loadList(reset = false) {
  if (reset) state.page = 1;
  syncFiltersToUrl();
  const params = new URLSearchParams();
  if (state.archive) params.set('archive', '1');
  if (state.type) params.set('type', state.type);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.date) params.set('date', state.date);
  params.set('page', String(state.page));

  // Сервер уже нарисовал строки (SSR) — не мигаем заглушкой, дождавшись данных
  if (state.page === 1 && !$('#list').dataset.ssr) {
    $('#list').replaceChildren(el('p', { class: 'empty-note', text: 'смотрю доску…' }));
  }

  try {
    const res = await api(`/api/listings?${params}`);
    if (!res.ok) throw new Error('network');
    const data = await res.json();
    state.hasMore = data.hasMore;
    state.total = data.total ?? data.items.length;

    cacheListings(data.items);
    const listEl = $('#list');
    listEl.removeAttribute('data-ssr');
    if (state.page === 1) listEl.replaceChildren();
    if (data.items.length === 0 && state.page === 1) listEl.replaceChildren();
    // Один фрагмент вместо N вставок: меньше перерасчётов макета при прокрутке
    const frag = document.createDocumentFragment();
    for (const l of data.items) frag.append(buildRow(l));
    listEl.append(frag);

    $('#total-count').textContent = `${state.total} ${plural(state.total, 'объявление', 'объявления', 'объявлений')}`;
    $('#list-empty').hidden = !(state.total === 0 && !state.archive);
    if (state.archive && state.total === 0) {
      listEl.append(el('p', {
        class: 'empty-note',
        text: 'В архиве пока пусто. Заявки попадают сюда на следующий день после даты выезда и живут месяц.',
      }));
    }
    $('#load-more').hidden = !state.hasMore;

    if (data.counts) {
      $('#c-all').textContent = `(${state.total})`;
      $('#c-offer').textContent = `(${data.counts.offer ?? 0})`;
      $('#c-request').textContent = `(${data.counts.request ?? 0})`;
    }
  } catch {
    $('#list').replaceChildren(el('p', { class: 'empty-note', text: 'Доска не отвечает. Обновите страницу, обычно это лечится.' }));
  }
}

function bindBoard() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      if (tab.dataset.type === 'archive') {
        state.archive = true;
        state.type = '';
      } else {
        state.archive = false;
        state.type = tab.dataset.type;
      }
      loadList(true);
    });
  });

  let timer;
  const debounce = (fn) => (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(e), 450);
  };
  $('#f-from').addEventListener('input', debounce((e) => { state.from = e.target.value.trim(); loadList(true); }));
  $('#f-to').addEventListener('input', debounce((e) => { state.to = e.target.value.trim(); loadList(true); }));
  $('#f-date').addEventListener('change', (e) => { state.date = e.target.value; loadList(true); });
  $('#f-go').addEventListener('click', () => loadList(true));

  $('#f-clear').addEventListener('click', () => {
    state.from = ''; state.to = ''; state.date = '';
    $('#f-from').value = ''; $('#f-to').value = ''; $('#f-date').value = '';
    loadList(true);
  });

  $$('.quick-routes a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const { from, to } = a.dataset;
      state.from = from; state.to = to;
      $('#f-from').value = from; $('#f-to').value = to;
      loadList(true);
    });
  });

  $('#load-more').addEventListener('click', async () => {
    state.page += 1;
    await loadList(false);
  });

  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    loadList(true);
  });
}

/* Сегодняшняя дата YYYY-MM-DD по Москве/Минску (UTC+3) — день выезда сравниваем с ней */
function mskTodayIso() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ---------- карточка ---------- */

/* Строки доски уже содержат все данные карточки — держим их в кэше и рисуем
   объявление мгновенно, в тот же кадр, что и клик. Сеть потом просто
   обновляет данные и засчитывает просмотр. */
const listingCache = new Map();
const detailInflight = new Map();

function cacheListings(items) {
  for (const l of items) if (l && l.id) listingCache.set(l.id, l);
}

/** Один запрос на объявление: повторный клик или возврат «назад» его не дублирует. */
function fetchListing(id) {
  const started = detailInflight.get(id);
  if (started) return started;
  const p = api(`/api/listings/${encodeURIComponent(id)}`)
    // целый ответ, а не только item: в нём related и пути для хлебных крошек —
    // из того же набора сервер собирает карточку при прямой загрузке страницы
    .then(async (res) => {
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.item ? data : null;
    })
    .catch(() => null);
  detailInflight.set(id, p);
  setTimeout(() => { if (detailInflight.get(id) === p) detailInflight.delete(id); }, 30000);
  return p;
}

async function loadDetail(id) {
  const box = $('#item-detail');
  const cached = listingCache.get(id);
  // Рисуем сразу то, что уже есть: никакой паузы «достаю карточку…» после клика
  if (cached) renderDetail(cached);
  else box.replaceChildren(el('p', { class: 'empty-note', text: 'достаю карточку…' }));

  const payload = await fetchListing(id);
  const l = payload ? payload.item : null;
  if (l) {
    listingCache.set(l.id, l);
    renderDetail(l, payload);
  } else if (!cached) {
    box.replaceChildren(
      el('p', { class: 'empty-note', text: 'Такого объявления нет. Возможно, его сняли после жалоб.' }),
      el('a', { class: 'back', href: '/', text: '← к доске' }),
    );
  }
}

/** Хлебные крошки карточки — те же, что печатает сервер (src/ssr.ts) и что
 *  лежат в JSON-LD BreadcrumbList: Доска › город › маршрут › №.
 *  Пути города и маршрута знает только сервер (витринный slug или динамический,
 *  есть ли страница города), поэтому до его ответа рисуем короткую цепочку —
 *  высота строки та же, контент не прыгает. */
function buildCrumbs(l, meta) {
  const sep = () => [' ', el('span', { class: 'crumb-sep', text: '›' }), ' '];
  const parts = [el('a', { href: '/', text: 'Доска' })];
  if (meta && meta.cityPath) parts.push(...sep(), el('a', { href: meta.cityPath, text: l.fromCity }));
  if (meta && meta.routePath) parts.push(...sep(), el('a', { href: meta.routePath, text: `${l.fromCity} → ${l.toCity}` }));
  parts.push(...sep(), el('span', { text: `№ ${l.id.slice(0, 8)}` }));
  return el('nav', { class: 'crumbs', 'aria-label': 'Хлебные крошки' }, parts);
}

function renderDetail(l, meta) {
  const box = $('#item-detail');
  // Серверная карточка (src/ssr.ts) полнее клиентской: в ней хлебные крошки и
  // блок «Ещё по этому маршруту». Пока открыто то же объявление — не
  // перерисовываем: иначе через секунду после загрузки контент схлопывается
  // на глазах. Кнопки сервера работают — их ловит общий обработчик
  // (data-report / data-copy), ссылки на похожие заявки тоже.
  if (box.dataset.ssr === '1' && box.dataset.id === l.id) return;
  box.removeAttribute('data-ssr');
  box.removeAttribute('data-id');
  // Дата поездки прошла — заявка в архиве (месяц ещё доступна, потом удаляется).
  // Регулярный рейс — не архив: дата показывает ближайший заезд, cron катит её вперёд.
  const archived =
    l.status === 'expired' ||
    (l.departureDate != null && l.departureDate < mskTodayIso() && !l.recurring);

  const contact = contactInfo(l);
  const actions = [];
  if (contact) {
    actions.push(
      el('a', {
        class: 'btn btn-ink btn-lg',
        href: contact.href,
        target: '_blank',
        rel: 'noopener',
        text: `${contact.kind === 'phone' ? 'позвонить' : 'написать'} ${contact.label}`,
      })
    );
  }
  actions.push(
    el('a', {
      class: 'link-btn',
      href: `/item/${l.id}`,
      onclick: (e) => { e.preventDefault(); openReport(l.id); },
      text: 'пожаловаться',
    })
  );
  actions.push(
    el('button', {
      class: 'btn btn-line btn-lg',
      text: 'скопировать ссылку',
      onclick: () => copyListingLink(l),
    })
  );

  const cells = [];
  if (l.departureDate) {
    cells.push(el('div', { class: 'cell' }, [
      el('span', { class: 'label', text: l.recurring ? 'ближайший выезд' : 'выезд' }),
      el('span', { class: 'value', text: fmtFullDate(l.departureDate) }),
    ]));
  } else {
    cells.push(el('div', { class: 'cell' }, [
      el('span', { class: 'label', text: 'выезд' }),
      el('span', { class: 'value', text: l.recurring ? l.recurring : 'дата не указана' }),
    ]));
  }
  if (l.recurring) {
    cells.push(el('div', { class: 'cell' }, [
      el('span', { class: 'label', text: 'регулярно' }),
      el('span', { class: 'value', text: l.recurring }),
    ]));
  }
  if (l.weightKg != null) {
    cells.push(el('div', { class: 'cell' }, [
      el('span', { class: 'label', text: 'вес' }),
      el('span', { class: 'value', text: `${String(l.weightKg).replace('.', ',')} кг` }),
    ]));
  }
  if (l.price) {
    cells.push(el('div', { class: 'cell' }, [
      el('span', { class: 'label', text: 'цена' }),
      el('span', { class: 'value', text: l.price }),
    ]));
  }
  cells.push(el('div', { class: 'cell' }, [
    el('span', { class: 'label', text: 'источник' }),
    el('span', { class: 'value' }, [sourceContent(l)]),
  ]));
  cells.push(el('div', { class: 'cell' }, [
    el('span', { class: 'label', text: 'добавлено' }),
    // полная дата, как в серверной карточке: относительное «3 дн. назад»
    // устаревает в кэше и не совпадает с HTML при прямой загрузке
    el('span', { class: 'value', text: fmtFullDate((l.publishedAt || l.createdAt || '').slice(0, 10)) }),
  ]));

  // Похожие заявки того же маршрута: клик по такой строке рисует карточку
  // мгновенно — данные уже в кэше.
  const related = meta && Array.isArray(meta.related) ? meta.related : [];
  for (const r of related) listingCache.set(r.id, r);

  box.replaceChildren(
    buildCrumbs(l, meta),
    el('div', { class: 'd-head' }, [
      el('h1', { class: 'd-route' }, [
        l.fromCity,
        ' ',
        el('span', { class: 'r-arrow', text: '→' }),
        ' ',
        el('span', { class: 'r-to', text: l.toCity }),
      ]),
      el('span', { class: `stamp stamp-${l.type}`, text: l.type === 'offer' ? 'водитель везёт' : 'ищу передачу' }),
      ...(l.recurring ? [el('span', { class: 'stamp stamp-recur', text: 'регулярно' })] : []),
      ...(archived ? [el('span', { class: 'stamp stamp-expired', text: 'архив' })] : []),
    ]),
    el('div', { class: 'd-meta' }, cells),
    ...(archived
      ? [el('p', {
          class: 'd-note',
          text: 'Дата поездки прошла — заявка в архиве. Ещё месяц она доступна по ссылке, потом удалится. Автору всё ещё можно написать с вопросом.',
        })]
      : []),
    el('p', { class: 'd-desc', text: l.description }),
    el('div', { class: 'd-actions' }, actions),
    el('p', {
      class: 'd-note',
      text: 'Объявление проверено модератором, но это не гарантия: связывайтесь с человеком, задавайте вопросы и не передавайте деньги заранее. Опечатка или фейк, нажмите «пожаловаться», разберусь.',
    }),
    ...(related.length > 0
      ? [
          el('h2', { class: 'rule-head', text: 'Ещё по этому маршруту' }),
          el('div', { class: 'rows' }, related.map((r) => buildRow(r))),
        ]
      : []),
  );
}

let reportReason = '';
function openReport(id) {
  const reason = window.prompt('Что не так с объявлением? (одной строкой)', '');
  if (reason === null) return;
  reportReason = reason;
  submitReport(id);
}

async function submitReport(id) {
  try {
    const res = await api(`/api/listings/${encodeURIComponent(id)}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reportReason }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'fail');
    toast(data.message || 'Жалоба принята.');
  } catch (ex) {
    const msg = ex && ex.message === 'not_found'
      ? 'Такое объявление уже снято с доски — жаловаться не на что.'
      : ex && ex.message === 'too_many_requests'
        ? 'Слишком много жалоб подряд. Подождите немного и попробуйте ещё раз.'
        : 'Не получилось отправить жалобу. Попробуйте позже.';
    toast(msg);
  }
}

/* ---------- форма ---------- */

function bindForm() {
  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    err.hidden = true;

    const fd = new FormData(e.target);
    const payload = {
      type: fd.get('ltype'),
      fromCity: fd.get('fromCity'),
      toCity: fd.get('toCity'),
      departureDate: fd.get('departureDate') || null,
      recurring: fd.get('recurring') || null,
      weightKg: fd.get('weightKg') ? Number(fd.get('weightKg')) : null,
      price: fd.get('price') || null,
      description: fd.get('description'),
      telegram: fd.get('telegram') || null,
      phone: fd.get('phone') || null,
    };

    if (!payload.telegram && !payload.phone) {
      err.textContent = 'Нужен хотя бы один контакт: telegram или телефон.';
      err.hidden = false;
      return;
    }

    const btn = $('#submit-btn');
    btn.disabled = true;
    btn.textContent = 'отправляю…';

    try {
      const res = await api('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не прошло. Проверьте поля.');
      const dupeId = data.duplicate && data.item && data.item.id ? data.item.id : null;
      toast(data.message || 'Ушло на проверку.');
      e.target.reset();
      if (dupeId) {
        navTo(`/item/${dupeId}`); // вторая заявка не нужна — показываем ту, что уже есть
      } else {
        navTo('/');
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отправить на проверку';
    }
  });
}

/* ---------- админ-панель ---------- */

const ADMIN_KEY_STORAGE = 'popoutka_admin_key';
let adminTab = 'pending'; // 'pending' | 'board' | 'chats' | 'match' | 'dupes' | 'stats'
let statsMonth = null; // выбранный месяц на вкладке «итоги»
let adminEditId = null; // id заявки, открытой на редактирование
let adminItems = [];   // список открытой вкладки — правим на месте, без перезагрузки
let adminPruned = 0;   // сколько просроченных заявок удалили при загрузке очереди

function adminKey() { return localStorage.getItem(ADMIN_KEY_STORAGE) || ''; }

async function adminApi(path, options = {}) {
  return api(path, {
    ...options,
    headers: { Authorization: `Bearer ${adminKey()}`, ...(options.headers || {}) },
  });
}

/* Предупреждение о дубле: одно и то же объявление пересылают каждый день,
   и в очереди модерации видно, что такая заявка уже есть (или уже на доске). */
function duplicateNote(l) {
  const d = l.duplicate;
  if (!d || !d.id) return null;
  const where = d.status === 'published' ? 'уже на доске'
    : d.status === 'expired' ? 'в архиве'
    : 'уже в очереди модерации';
  return el('p', { class: `dup-warn dup-${d.kind}` }, [
    el('b', { text: d.kind === 'duplicate' ? '♻️ Это повтор — ' : '⚠️ Похоже на дубль — ' }),
    `такая заявка ${where}: `,
    el('a', { href: `/item/${d.id}`, text: `№ ${d.id.slice(0, 8)}` }),
    ` · ${d.fromCity} → ${d.toCity}${d.departureDate ? ` · ${fmtDate(d.departureDate)}` : ''}`,
    el('span', { class: 'dup-why', text: d.why }),
  ]);
}

function adminCard(l, mode = 'pending') {
  const contact = contactInfo(l);
  const meta = [
    el('span', { text: ago(l.publishedAt || l.createdAt) }),
    l.departureDate ? el('span', { text: `выезд ${fmtDate(l.departureDate)}` }) : null,
    l.weightKg != null ? el('span', { class: 'mono', text: `${String(l.weightKg).replace('.', ',')} кг` }) : null,
    l.price ? el('span', { class: 'mono', text: l.price }) : null,
    el('span', { class: 'src' }, [sourceContent(l)]),
  ];
  const editBtn = el('button', {
    class: 'btn btn-line btn-sm',
    text: adminEditId === l.id ? 'закрыть' : 'редактировать',
    onclick: () => { adminEditId = adminEditId === l.id ? null : l.id; loadAdmin(); },
  });

  // Связи: встречные рейсы, тот же маршрут, другие заявки контакта
  const relatedBox = el('div', { class: 'admin-edit' });
  relatedBox.hidden = true;
  const relBtn = el('button', {
    class: 'btn btn-line btn-sm',
    text: 'связи',
    onclick: async () => {
      if (!relatedBox.hidden) { relatedBox.hidden = true; return; }
      relatedBox.hidden = false;
      relatedBox.replaceChildren(el('p', { class: 'admin-contact', text: 'ищу связи…' }));
      try {
        const res = await adminApi(`/api/admin/listings/${encodeURIComponent(l.id)}/related`);
        if (!res.ok) throw new Error();
        const rel = await res.json();
        const line = (x) => {
          const c = contactInfo(x); // контакт без дублей: номер из поля telegram тоже покажется номером
          return el('p', {
            class: 'admin-contact',
            text: `${x.fromCity} → ${x.toCity}${x.departureDate ? ` · выезд ${fmtDate(x.departureDate)}` : ''}${x.recurring ? ` · ↻ ${x.recurring}` : ''}${c ? ` · ${c.label}` : ''} · ${x.status === 'pending' ? 'на модерации' : x.status === 'expired' ? 'архив' : 'на доске'} · № ${x.id.slice(0, 8)}`,
          });
        };
        const parts = [];
        if (rel.reverse?.length) parts.push(el('p', { class: 'label', text: `↔ встречные (${rel.reverse.length})` }), ...rel.reverse.map(line));
        if (rel.same?.length) parts.push(el('p', { class: 'label', text: `тот же маршрут (${rel.same.length})` }), ...rel.same.map(line));
        if (rel.sameContact?.length) parts.push(el('p', { class: 'label', text: `тот же контакт (${rel.sameContact.length})` }), ...rel.sameContact.map(line));
        relatedBox.replaceChildren(...(parts.length ? parts : [el('p', { class: 'admin-contact', text: 'Связей нет: ни встречных, ни похожих.' })]));
      } catch {
        relatedBox.replaceChildren(el('p', { class: 'admin-contact', text: 'Не получилось загрузить связи.' }));
      }
    },
  });
  const actions = mode === 'pending'
    ? [
        el('button', { class: 'btn btn-ink btn-sm', text: 'одобрить', onclick: () => adminSetStatus(l.id, 'published') }),
        el('button', { class: 'btn btn-line btn-sm', text: 'отклонить', onclick: () => adminSetStatus(l.id, 'rejected') }),
        editBtn,
        relBtn,
      ]
    : [
        editBtn,
        relBtn,
        l.status === 'expired'
          ? el('button', { class: 'btn btn-ink btn-sm', text: 'на доску', onclick: () => adminSetStatus(l.id, 'published') })
          : el('button', { class: 'btn btn-line btn-sm', text: 'в архив', onclick: () => adminSetStatus(l.id, 'expired') }),
        el('button', { class: 'btn btn-line btn-sm danger', text: 'удалить', onclick: () => adminDelete(l.id) }),
      ];
  return el('article', { class: 'admin-card', 'data-id': l.id }, [
    duplicateNote(l),
    el('h3', { class: 'route-line' }, [
      l.fromCity,
      el('span', { class: 'r-arrow', text: '→' }),
      el('span', { class: 'r-to', text: l.toCity }),
      el('span', { class: `stamp stamp-${l.type}`, text: l.type === 'offer' ? 'водитель везёт' : 'ищу передачу' }),
      l.status === 'expired' ? el('span', { class: 'stamp stamp-expired', text: 'архив' }) : null,
    ].filter(Boolean)),
    el('div', { class: 'meta-line' }, [
      ...meta,
      mode === 'board' ? el('span', { text: `${l.views || 0} ${plural(l.views || 0, 'просмотр', 'просмотра', 'просмотров')}` }) : null,
      el('span', { class: 'mono', text: `№ ${l.id.slice(0, 8)}` }),
    ].filter(Boolean)),
    el('p', { class: 'desc', text: l.description }),
    contact
      ? el('p', { class: 'admin-contact' }, [
          'контакт: ',
          el('a', { href: contact.href, target: '_blank', rel: 'noopener', text: contact.label }),
        ])
      : el('p', { class: 'admin-contact admin-contact-none', text: 'контакт не указан' }),
    ...(adminEditId === l.id ? [adminEditForm(l)] : []),
    relatedBox,
    el('div', { class: 'admin-card-actions' }, actions),
  ]);
}

/* Форма редактирования заявки: те же поля, что и на сайте. */
function adminEditForm(l) {
  const field = (labelText, control) =>
    el('label', { class: 'field' }, [el('span', { class: 'label', text: labelText }), control]);
  const input = (name, value, attrs = {}) =>
    el('input', { class: 'q', name, value: value ?? '', ...attrs });

  const form = el('form', { class: 'admin-edit' }, [
    el('div', { class: 'row2' }, [
      field('Тип', el('select', { class: 'q', name: 'type' }, [
        el('option', { value: 'offer', ...(l.type === 'offer' ? { selected: true } : {}), text: 'водитель везёт' }),
        el('option', { value: 'request', ...(l.type === 'request' ? { selected: true } : {}), text: 'нужно передать' }),
      ])),
      field('Дата выезда', input('departureDate', l.departureDate ?? '', { type: 'date' })),
      field('Регулярно (расписание)', input('recurring', l.recurring ?? '', { placeholder: 'каждый четверг / по будням' })),
    ]),
    el('div', { class: 'row2' }, [
      field('Откуда', input('fromCity', l.fromCity)),
      field('Куда', input('toCity', l.toCity)),
    ]),
    el('div', { class: 'row2' }, [
      field('Вес, кг', input('weightKg', l.weightKg ?? '', { type: 'number', min: '0.1', max: '1000', step: '0.1' })),
      field('Цена', input('price', l.price ?? '')),
    ]),
    el('div', { class: 'row2' }, [
      field('Telegram', input('telegram', l.telegram ?? '', { placeholder: '@username' })),
      field('Телефон', input('phone', l.phone ?? '', { placeholder: '+48 …' })),
    ]),
    el('p', {
      class: 'form-note',
      text: 'Автор пересылки скрыл профиль и контакта нет? Впишите номер или @username вручную — можно из исходного сообщения (ссылка «источник» выше). Одно и то же в оба поля писать не нужно.',
    }),
    field('Описание', el('textarea', { class: 'q', name: 'description', rows: '3' }, [l.description])),
    el('div', { class: 'admin-card-actions' }, [
      el('button', { class: 'btn btn-ink btn-sm', type: 'submit', text: 'сохранить' }),
      el('button', { class: 'btn btn-line btn-sm', type: 'button', text: 'отмена', onclick: () => { adminEditId = null; loadAdmin(); } }),
    ]),
  ]);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      type: fd.get('type'),
      fromCity: fd.get('fromCity'),
      toCity: fd.get('toCity'),
      departureDate: fd.get('departureDate') || null,
      recurring: fd.get('recurring') || null,
      weightKg: fd.get('weightKg') ? Number(fd.get('weightKg')) : null,
      price: fd.get('price') || null,
      description: fd.get('description'),
      telegram: fd.get('telegram') || null,
      phone: fd.get('phone') || null,
    };
    try {
      const res = await adminApi(`/api/admin/listings/${encodeURIComponent(l.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Ошибка');
      adminEditId = null;
      toast(data.warning === 'no_contact' ? 'Сохранено. Но контакта у заявки нет — писать человеку некуда.' : 'Сохранено.');
      // карточку перерисовываем на месте из ответа сервера — без перезагрузки очереди
      if (data.item) rerenderAdminCard(data.item);
      else await loadAdmin();
    } catch (ex) {
      toast(`Не сохранилось: ${ex.message}`);
    }
  });
  return form;
}

async function loadAdmin() {
  if (!adminKey()) {
    $('#admin-login').hidden = false;
    $('#admin-panel').hidden = true;
    return;
  }
  $('#admin-login').hidden = true;
  $('#admin-panel').hidden = false;
  $('#admin-list').replaceChildren(el('p', { class: 'empty-note', text: 'загружаю…' }));
  if (adminTab === 'chats') {
    await renderAdminChats();
    return;
  }
  if (adminTab === 'match') {
    await renderAdminMatch();
    return;
  }
  if (adminTab === 'dupes') {
    await renderAdminDupes();
    return;
  }
  if (adminTab === 'stats') {
    await renderAdminStats();
    return;
  }
  try {
    const res = await adminApi(`/api/admin/listings?tab=${adminTab}`);
    if (res.status === 401) {
      localStorage.removeItem(ADMIN_KEY_STORAGE);
      $('#admin-login').hidden = false;
      $('#admin-panel').hidden = true;
      const err = $('#admin-err');
      err.textContent = 'Ключ неверный или ADMIN_API_TOKEN не задан в воркере.';
      err.hidden = false;
      return;
    }
    if (!res.ok) throw new Error('network');
    const data = await res.json();
    adminItems = data.items ?? [];
    adminPruned = data.pruned ?? 0;
    renderAdminItems();
  } catch {
    $('#admin-list').replaceChildren(el('p', { class: 'empty-note', text: 'Не получилось загрузить. Проверьте связь и нажмите «обновить».' }));
  }
}

/* ---------- очередь без перезагрузки ---------- */
/* «Одобрить»/«отклонить» меняют список на месте: карточка исчезает, соседние
   остаются как были (открытые «связи», форма редактирования, прокрутка).
   Раньше после каждого решения очередь перезагружалась целиком — «загружаю…»
   и список с самого верха. */

function updateAdminCount() {
  const n = adminItems.length;
  const prunedNote = adminTab === 'pending' && adminPruned > 0
    ? ` · просроченных удалено: ${adminPruned}`
    : '';
  $('#admin-count').textContent = adminTab === 'pending'
    ? (n === 0
        ? '✅ Необработанных заявок нет.'
        : `⏳ Необработано заявок: ${n}${prunedNote}`)
    : (n === 0
        ? 'На доске пока пусто.'
        : `На доске: ${n} — действующие и архив`);
}

/** Нарисовать список заявок из adminItems — без сети. */
function renderAdminItems() {
  const listEl = $('#admin-list');
  listEl.replaceChildren();
  if (adminItems.length === 0) {
    listEl.append(el('p', {
      class: 'empty-note',
      text: adminTab === 'pending' ? 'Очередь пуста. Новые заявки появятся здесь.' : 'На доске ничего нет.',
    }));
  } else {
    for (const l of adminItems) listEl.append(adminCard(l, adminTab));
  }
  updateAdminCount();
}

function adminCardNode(id) {
  return document.querySelector(`#admin-list .admin-card[data-id="${CSS.escape(id)}"]`);
}

/** Убрать заявку из списка на месте — карточка исчезает, остальное не трогаем. */
function dropAdminCard(id) {
  adminItems = adminItems.filter((x) => x.id !== id);
  const node = adminCardNode(id);
  if (node) node.remove();
  if (adminItems.length === 0) renderAdminItems(); // покажет «очередь пуста»
  else updateAdminCount();
}

/** Перерисовать одну карточку (сменился статус или содержимое после правки). */
function rerenderAdminCard(item) {
  const idx = adminItems.findIndex((x) => x.id === item.id);
  if (idx === -1) { renderAdminItems(); return; }
  adminItems[idx] = item;
  const node = adminCardNode(item.id);
  if (node) node.replaceWith(adminCard(item, adminTab));
  else renderAdminItems();
  updateAdminCount();
}

async function renderAdminChats() {
  const listEl = $('#admin-list');
  try {
    const res = await adminApi('/api/admin/source-chats');
    if (!res.ok) throw new Error();
    const { chats, needsSetup } = await res.json();
    if (needsSetup) {
      // таблицы ссылок ещё нет в базе — предложим создать одним кликом
      $('#admin-count').textContent = 'Один шаг до готовности: нужна таблица ссылок.';
      listEl.replaceChildren(
        el('p', {
          class: 'empty-note',
          text: 'В базе ещё нет таблицы chat_links. Она только хранит ссылки на чаты — существующие объявления и настройки не трогаются. Создать можно прямо здесь.',
        }),
        el('div', { class: 'admin-card-actions' }, [
          el('button', {
            class: 'btn btn-ink', type: 'button', text: 'создать таблицу',
            onclick: async () => {
              try {
                const r = await adminApi('/api/admin/ensure-chat-links', { method: 'POST' });
                if (!r.ok) throw new Error();
                toast('Таблица создана.');
                await renderAdminChats();
              } catch {
                toast('Не получилось создать. Попробуйте ещё раз.');
              }
            },
          }),
        ])
      );
      return;
    }
    $('#admin-count').textContent = chats.length
      ? `Чатов-источников: ${chats.length}. Ссылка t.me/… делает подпись «из чата …» на доске кликабельной для всех.`
      : 'Чатов пока нет: добавьте бота в чат или перешлите ему сообщение — источники появятся здесь.';
    listEl.replaceChildren();
    for (const ch of chats) {
      const input = el('input', {
        class: 'q', type: 'url', placeholder: 'https://t.me/…',
        value: ch.url || '', autocomplete: 'off',
      });
      const save = el('button', {
        class: 'btn btn-ink btn-sm', type: 'button', text: 'сохранить',
        onclick: async () => {
          const url = input.value.trim();
          if (url && !/^https:\/\/t\.me\//.test(url)) {
            toast('Нужна ссылка вида https://t.me/…');
            return;
          }
          try {
            const r = await adminApi('/api/admin/chat-links', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chatId: ch.chatId, url }),
            });
            if (!r.ok) throw new Error();
            toast(url ? 'Ссылка сохранена.' : 'Ссылка убрана.');
            chatLinks = {}; // перезагрузим на следующем открытии сайта
            await renderAdminChats();
          } catch {
            toast('Не получилось сохранить. Попробуйте ещё раз.');
          }
        },
      });
      listEl.append(el('article', { class: 'admin-card' }, [
        el('p', { class: 'admin-contact', text: `${ch.title || 'без названия'} · заявок: ${ch.count} · id ${ch.chatId}` }),
        el('div', { class: 'admin-card-actions' }, [input, save]),
      ]));
    }
  } catch {
    listEl.replaceChildren(el('p', { class: 'empty-note', text: 'Не получилось загрузить чаты. Нажмите «обновить».' }));
  }
}

/* ---------- вкладка «подбор»: пары «водитель везёт» ↔ «нужно передать» ---------- */

let matchRuns = [];        // история прогонов
let matchView = null;      // показанный сейчас результат: { title, pairs, stats?, run? }
let matchOpenRunId = null; // какой прогон истории раскрыт
let matchFormEl = null;    // форма одна на вкладку, чтобы не терять введённые города

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function matchWhere(run) {
  const where = [run?.fromCity, run?.toCity].filter(Boolean).join(' → ').trim();
  return where || 'все города';
}

/* Одна сторона пары: снимок заявки (те же поля приходят и из истории прогонов). */
function matchSide(s, icon) {
  if (!s) return el('p', { class: 'match-desc', text: 'заявка удалена — снимок не сохранился' });
  const bits = [
    el('span', { class: 'match-route', text: `${s.fromCity} → ${s.toCity}` }),
    el('span', { text: s.departureDate ? `выезд ${fmtDate(s.departureDate)}` : 'дата не указана' }),
    s.recurring ? el('span', { text: `↻ ${s.recurring}` }) : null,
    s.weightKg != null ? el('span', { class: 'mono', text: `${String(s.weightKg).replace('.', ',')} кг` }) : null,
    s.price ? el('span', { class: 'mono', text: s.price }) : null,
    s.status === 'expired' ? el('span', { class: 'stamp stamp-expired', text: 'архив' }) : null,
    el('span', { class: 'mono', text: `№ ${String(s.id).slice(0, 8)}` }),
  ].filter(Boolean);
  const contacts = Array.isArray(s.contacts) ? s.contacts : [];
  return el('div', { class: 'match-side' }, [
    el('p', { class: 'match-side-head' }, [el('span', { class: 'match-icon', text: icon }), ...bits]),
    s.description ? el('p', { class: 'match-desc', text: s.description }) : null,
    contacts.length
      ? el('p', { class: 'match-contact' }, ['контакт: ', el('b', { text: contacts.join(', ') })])
      : el('p', { class: 'match-contact match-nocontact', text: 'контакта нет — допишите его в карточке заявки («править»)' }),
  ].filter(Boolean));
}

/* Текст, который админ копирует и отправляет людям — знакомим их напрямую. */
function matchMessage(p) {
  const site = `${location.origin}${location.pathname}`.replace(/\/$/, '');
  const side = (s) => `${s.fromCity} → ${s.toCity}` +
    (s.departureDate ? `, выезд ${s.departureDate}` : '') +
    (s.weightKg != null ? `, ${String(s.weightKg).replace('.', ',')} кг` : '') +
    `, контакт: ${s.contacts?.[0] ?? 'не указан'}`;
  return [
    'Здравствуйте! На доске «Попутка» нашлась пара по вашему маршруту:',
    `🚗 водитель везёт: ${side(p.offer)}`,
    `📦 нужно передать: ${side(p.request)}`,
    '',
    `${site}/item/${p.offer.id}`,
    `${site}/item/${p.request.id}`,
    '',
    'Напишите друг другу и договоритесь о деталях — доска только знакомит.',
  ].join('\n');
}

/** Скопировать текст в буфер. Подписи тоста можно свои — смысл копирования разный. */
async function copyText(text, opts = {}) {
  const okText = opts.ok || 'Сообщение скопировано — можно вставлять в Telegram.';
  const failText = opts.fail || 'Скопировать не получилось. Откройте карточки и напишите вручную.';
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(okText);
  } catch {
    toast(failText);
  }
}

function matchPairCard(p, i) {
  const reasons = Array.isArray(p.reasons) ? p.reasons : String(p.reason ?? '').split('; ').filter(Boolean);
  return el('article', { class: 'admin-card match-pair' }, [
    el('p', { class: 'match-pair-head' }, [
      el('span', { class: 'match-score', text: `пара ${i} · оценка ${p.score}` }),
      ...reasons.map((r) => el('span', { class: 'match-reason', text: r })),
    ]),
    matchSide(p.offer, '🚗'),
    matchSide(p.request, '📦'),
    el('div', { class: 'admin-card-actions' }, [
      el('a', { class: 'btn btn-line btn-sm', href: `/item/${p.offer.id}`, text: 'водитель' }),
      el('a', { class: 'btn btn-line btn-sm', href: `/item/${p.request.id}`, text: 'заявка' }),
      el('button', {
        class: 'btn btn-line btn-sm', type: 'button', text: 'скопировать сообщение',
        onclick: () => copyText(matchMessage(p)),
      }),
    ]),
  ]);
}

function matchForm() {
  const field = (labelText, control) =>
    el('label', { class: 'field' }, [el('span', { class: 'label', text: labelText }), control]);
  const check = (name, labelText, checked) => el('label', { class: 'match-check' }, [
    el('input', { type: 'checkbox', name, ...(checked ? { checked: true } : {}) }),
    el('span', { text: labelText }),
  ]);

  const form = el('form', { class: 'admin-card match-form' }, [
    el('p', {
      class: 'admin-contact',
      text: 'Одна кнопка — сравнить всех водителей со всеми заявками «нужно передать» и показать, кому написать. Города можно оставить пустыми (тогда берём все) или задать, например «водители Варшава — заявки на передачу в Минск».',
    }),
    el('div', { class: 'row2' }, [
      field('Город отправления', el('input', { class: 'q', name: 'fromCity', placeholder: 'например, Варшава', autocomplete: 'off' })),
      field('Город назначения', el('input', { class: 'q', name: 'toCity', placeholder: 'например, Минск', autocomplete: 'off' })),
    ]),
    el('div', { class: 'row2' }, [
      field('Окно по датам, дней', el('input', { class: 'q', name: 'days', type: 'number', min: '1', max: '30', value: '3' })),
      field('Заметка к прогону', el('input', { class: 'q', name: 'note', placeholder: 'необязательно', autocomplete: 'off' })),
    ]),
    el('div', { class: 'match-checks' }, [
      check('includeArchive', 'брать и архив', false),
      check('partial', 'пары с одним общим городом', false),
      check('notify', 'прислать сводку в Telegram', true),
    ]),
    el('div', { class: 'admin-card-actions' }, [
      el('button', { class: 'btn btn-ink btn-sm', type: 'submit', text: 'подобрать пары' }),
    ]),
    el('p', {
      class: 'form-note',
      text: 'Прогон сохранится в истории ниже и останется читаемым, даже когда сами заявки уйдут в архив и удалятся.',
    }),
  ]);
  form.addEventListener('submit', (e) => { e.preventDefault(); runMatch(form); });
  return form;
}

function matchStatsText(stats) {
  if (!stats) return '';
  const r = stats.rejected ?? {};
  return `В подборе: водителей ${stats.offers}, заявок ${stats.requests}. ` +
    `Отклонено: маршрут ${r.route ?? 0}, даты ${r.date_gap ?? 0}, вес ${r.weight ?? 0}, ` +
    `один контакт ${r.same_contact ?? 0}, архив ${r.archived ?? 0}.`;
}

function matchResultsBox() {
  if (!matchView) return el('div');
  const nodes = [
    el('div', { class: 'match-result-head' }, [
      el('p', { class: 'admin-contact', text: matchView.title }),
      matchView.stats ? el('p', { class: 'match-stats', text: matchStatsText(matchView.stats) }) : null,
      el('button', {
        class: 'link-btn', type: 'button', text: 'скрыть результат',
        onclick: () => { matchView = null; matchOpenRunId = null; renderMatchTab(); },
      }),
    ].filter(Boolean)),
  ];
  const pairs = matchView.pairs ?? [];
  if (!pairs.length) {
    nodes.push(el('p', {
      class: 'empty-note',
      text: 'Пар не нашлось. Попробуйте расширить окно по датам, включить архив или убрать города из фильтра.',
    }));
  }
  pairs.forEach((p, i) => nodes.push(matchPairCard(p, i + 1)));
  return el('section', { class: 'match-result' }, nodes);
}

function matchHistoryBox() {
  const head = el('h3', { class: 'match-history-head', text: `История подборов: ${matchRuns.length}` });
  if (!matchRuns.length) {
    return el('section', { class: 'match-history' }, [
      head,
      el('p', { class: 'empty-note', text: 'Прогонов пока нет. Нажмите «подобрать пары» — прогон сохранится здесь.' }),
    ]);
  }
  return el('section', { class: 'match-history' }, [
    head,
    ...matchRuns.map((r) => el('article', {
      class: `admin-card match-run${matchOpenRunId === r.id ? ' match-run-open' : ''}`,
    }, [
      el('p', { class: 'match-run-line' }, [
        el('b', { text: fmtDateTime(r.createdAt) }),
        ` · ${matchWhere(r)} · окно ${r.daysWindow} дн. · водителей ${r.offersTotal}, заявок ${r.requestsTotal} · пар ${r.pairsFound}`,
        r.notified ? el('span', { class: 'match-flag', text: 'сводка отправлена' }) : null,
        r.includeArchive ? el('span', { class: 'match-flag', text: 'с архивом' }) : null,
        r.partial ? el('span', { class: 'match-flag', text: 'один город тоже' }) : null,
        r.note ? el('span', { class: 'match-note', text: `заметка: ${r.note}` }) : null,
      ].filter(Boolean)),
      el('div', { class: 'admin-card-actions' }, [
        el('button', {
          class: 'btn btn-line btn-sm', type: 'button', text: 'открыть',
          onclick: () => openMatchRun(r.id),
        }),
        el('button', {
          class: 'link-btn', type: 'button', text: 'удалить',
          onclick: () => removeMatchRun(r.id),
        }),
      ]),
    ])),
  ]);
}

/* Перерисовать вкладку, не трогая форму (чтобы введённые города не пропадали). */
function renderMatchTab() {
  if (!matchFormEl) matchFormEl = matchForm();
  $('#admin-list').replaceChildren(matchFormEl, matchResultsBox(), matchHistoryBox());
}

async function refreshMatchRuns() {
  try {
    const res = await adminApi('/api/admin/match?limit=20');
    if (!res.ok) throw new Error();
    const { runs } = await res.json();
    matchRuns = Array.isArray(runs) ? runs : [];
  } catch {
    matchRuns = [];
  }
}

async function runMatch(form) {
  const btn = form.querySelector('button[type="submit"]');
  const fd = new FormData(form);
  const body = {
    fromCity: String(fd.get('fromCity') ?? '').trim(),
    toCity: String(fd.get('toCity') ?? '').trim(),
    days: Number(fd.get('days') ?? 3) || 3,
    note: String(fd.get('note') ?? '').trim(),
    includeArchive: fd.get('includeArchive') === 'on',
    partial: fd.get('partial') === 'on',
    notify: fd.get('notify') === 'on',
  };
  if (btn) { btn.disabled = true; btn.textContent = 'подбираю…'; }
  try {
    const res = await adminApi('/api/admin/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error('ключ администратора не подошёл');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'ошибка сервера');
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    matchView = {
      title: `Прогон только что · ${matchWhere(data.run)} · пар: ${pairs.length}` +
        (body.notify ? ' · сводка ушла в Telegram' : ''),
      pairs,
      stats: data.stats,
      run: data.run,
    };
    matchOpenRunId = data.run?.id ?? null;
    await refreshMatchRuns();
    renderMatchTab();
    toast(pairs.length
      ? `Готово: найдено пар ${pairs.length}.`
      : 'Готово: пар не нашлось — попробуйте другие города или окно по датам.');
  } catch (ex) {
    toast(`Подбор не получился: ${ex.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'подобрать пары'; }
  }
}

async function openMatchRun(id) {
  try {
    const res = await adminApi(`/api/admin/match/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error();
    const { run, pairs } = await res.json();
    matchOpenRunId = id;
    matchView = {
      title: `Прогон от ${fmtDateTime(run.createdAt)} · ${matchWhere(run)} · окно ${run.daysWindow} дн. · пар: ${(pairs ?? []).length}`,
      pairs: pairs ?? [],
      run,
    };
    renderMatchTab();
    window.scrollTo({ top: $('#admin-list').offsetTop - 12, behavior: 'smooth' });
  } catch {
    toast('Не получилось открыть прогон.');
  }
}

async function removeMatchRun(id) {
  if (!window.confirm('Удалить этот прогон из истории?')) return;
  try {
    const res = await adminApi(`/api/admin/match/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    if (matchOpenRunId === id) { matchOpenRunId = null; matchView = null; }
    toast('Прогон удалён.');
    await refreshMatchRuns();
    renderMatchTab();
  } catch {
    toast('Не получилось удалить прогон.');
  }
}

async function renderAdminMatch() {
  $('#admin-count').textContent = 'Подбор пар: одна кнопка сравнивает водителей с заявками на передачу и сохраняет прогон в историю.';
  $('#admin-list').replaceChildren(el('p', { class: 'empty-note', text: 'загружаю…' }));
  await refreshMatchRuns();
  renderMatchTab();
}

/* ---------- вкладка «повторы»: дубли, которые уже накопились ---------- */

let dupeGroups = [];

function dupeLine(l, isKeep) {
  const contact = contactInfo(l);
  return el('div', { class: `dupe-line${isKeep ? ' dupe-keep' : ''}` }, [
    el('span', { class: 'dupe-tag', text: isKeep ? 'оставить' : 'копия' }),
    el('a', { class: 'dupe-route', href: `/item/${l.id}`, text: `${l.fromCity} → ${l.toCity}` }),
    el('span', { text: l.departureDate ? fmtDate(l.departureDate) : 'без даты' }),
    l.status === 'expired' ? el('span', { class: 'stamp stamp-expired', text: 'архив' }) : null,
    el('span', { text: contact ? contact.label : 'нет контакта' }),
    el('span', { class: 'mono', text: `№ ${l.id.slice(0, 8)}` }),
    el('span', { class: 'dupe-ago', text: ago(l.publishedAt || l.createdAt) }),
    isKeep ? null : el('button', {
      class: 'link-btn', type: 'button', text: 'удалить',
      onclick: () => cleanDupes([l.id]),
    }),
  ].filter(Boolean));
}

function dupeGroup(g, i) {
  return el('article', { class: 'admin-card dupe-group' }, [
    el('p', { class: 'admin-contact' }, [
      `группа ${i + 1}: `,
      el('b', { text: `${g.duplicates.length} ${plural(g.duplicates.length, 'копия', 'копии', 'копий')}` }),
      ` — ${g.why}`,
    ]),
    dupeLine(g.keep, true),
    ...g.duplicates.map((d) => dupeLine(d, false)),
    el('div', { class: 'admin-card-actions' }, [
      el('button', {
        class: 'btn btn-line btn-sm', type: 'button',
        text: `удалить ${g.duplicates.length} ${plural(g.duplicates.length, 'копию', 'копии', 'копий')}`,
        onclick: () => cleanDupes(g.duplicates.map((d) => d.id)),
      }),
    ]),
  ]);
}

async function cleanDupes(ids) {
  const list = ids.filter(Boolean);
  if (!list.length) return;
  if (!window.confirm(`Удалить ${list.length} ${plural(list.length, 'копию', 'копии', 'копий')}? В каждой группе останется одна заявка.`)) return;
  let deleted = 0;
  try {
    // сервер принимает не больше 50 id за раз — режем на порции
    for (let i = 0; i < list.length; i += 50) {
      const res = await adminApi('/api/admin/duplicates/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: list.slice(i, i + 50) }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json().catch(() => ({}));
      deleted += data.deleted ?? 0;
    }
    toast(`Удалено копий: ${deleted}.`);
    await renderAdminDupes();
  } catch {
    toast('Не получилось удалить. Попробуйте ещё раз.');
  }
}

async function renderAdminDupes() {
  const listEl = $('#admin-list');
  $('#admin-count').textContent = 'Повторы: ищем одинаковые заявки, которые уже успели попасть на доску.';
  listEl.replaceChildren(el('p', { class: 'empty-note', text: 'ищу повторы…' }));
  try {
    const res = await adminApi('/api/admin/duplicates');
    if (res.status === 401) {
      localStorage.removeItem(ADMIN_KEY_STORAGE);
      $('#admin-login').hidden = false;
      $('#admin-panel').hidden = true;
      return;
    }
    if (!res.ok) throw new Error();
    const data = await res.json();
    dupeGroups = Array.isArray(data.groups) ? data.groups : [];
    const extra = data.extraCount ?? dupeGroups.reduce((n, g) => n + g.duplicates.length, 0);
    $('#admin-count').textContent = dupeGroups.length
      ? `Групп повторов: ${dupeGroups.length}, лишних заявок: ${extra}. Одну в группе оставляем, копии удаляем.`
      : `Повторов нет — проверено ${data.total ?? 0} ${plural(data.total ?? 0, 'заявка', 'заявки', 'заявок')}.`;
    listEl.replaceChildren();
    if (!dupeGroups.length) {
      listEl.append(el('p', {
        class: 'empty-note',
        text: 'Одинаковых заявок не нашлось: ни старых завалов, ни новых — защита от дублей работает.',
      }));
      return;
    }
    listEl.append(
      el('div', { class: 'admin-card-actions dupe-toolbar' }, [
        el('button', {
          class: 'btn btn-ink btn-sm', type: 'button', text: `удалить все копии (${extra})`,
          onclick: () => cleanDupes(dupeGroups.flatMap((g) => g.duplicates.map((d) => d.id))),
        }),
        el('span', {
          class: 'form-note',
          text: 'В каждой группе остаётся одна заявка — та, что на доске и с контактом. Копии удаляются вместе с жалобами на них.',
        }),
      ])
    );
    dupeGroups.forEach((g, i) => listEl.append(dupeGroup(g, i)));
  } catch {
    listEl.replaceChildren(el('p', {
      class: 'empty-note',
      text: 'Не получилось проверить повторы. Нажмите «обновить».',
    }));
  }
}

async function adminDelete(id) {
  if (!window.confirm('Удалить объявление навсегда? Вместе с жалобами.')) return;
  try {
    const res = await adminApi(`/api/admin/listings/${encodeURIComponent(id)}/delete`, { method: 'POST' });
    if (!res.ok) throw new Error();
    toast('Удалено.');
    dropAdminCard(id);
  } catch {
    toast('Не получилось удалить. Попробуйте ещё раз.');
  }
}

/* ---------- итоги месяца: текст для поста и цифры ---------- */

async function renderAdminStats() {
  const listEl = $('#admin-list');
  $('#admin-count').textContent = 'Итоги месяца: сколько объявлений прошло через доску и по чём договаривались.';
  listEl.replaceChildren(el('p', { class: 'empty-note', text: 'считаю…' }));
  let data;
  try {
    const res = await adminApi('/api/admin/stats');
    if (!res.ok) throw new Error('network');
    data = await res.json();
  } catch {
    listEl.replaceChildren(el('p', {
      class: 'empty-note',
      text: 'Не получилось загрузить итоги. Проверьте связь и нажмите «обновить».',
    }));
    return;
  }
  const months = data.months || [];
  if (months.length === 0) {
    listEl.replaceChildren(el('p', {
      class: 'empty-note',
      text: 'Пока считать нечего: на доске не было опубликованных объявлений. Как только появится первое, пересчитайте итоги здесь или дождитесь ночного cron.',
    }));
    return;
  }
  if (!statsMonth || !months.some((m) => m.month === statsMonth)) statsMonth = months[0].month;
  const stat = months.find((m) => m.month === statsMonth) || months[0];

  listEl.replaceChildren();

  // выбор месяца + пересчёт
  const select = el('select', {
    class: 'stats-month',
    onchange: (e) => { statsMonth = e.target.value; renderAdminStats(); },
  }, months.map((m) => el('option', {
    value: m.month,
    ...(m.month === stat.month ? { selected: true } : {}),
    text: `${fmtPeriodRu(m.month)} — ${m.total} объявл.`,
  })));
  const refreshBtn = el('button', {
    class: 'btn btn-line',
    type: 'button',
    onclick: async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'пересчитываю…';
      try {
        const res = await adminApi('/api/admin/stats/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error('network');
        const fresh = await res.json();
        toast(`Пересчитано месяцев: ${(fresh.saved || []).length || 0}.`);
        await renderAdminStats();
      } catch {
        toast('Пересчитать не получилось. Попробуйте ещё раз.');
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'пересчитать';
      }
    },
  }, 'пересчитать');

  // страница месяца и аналитическая заметка (текст на /itogi/YYYY-MM)
  const pageLink = el('a', {
    class: 'btn btn-line',
    href: stat.path || `/itogi/${stat.month}`,
    target: '_blank',
    rel: 'noopener',
  }, 'страница месяца');
  const summaryBtn = el('button', {
    class: 'btn btn-line',
    type: 'button',
    onclick: async () => {
      summaryBtn.disabled = true;
      summaryBtn.textContent = 'пишу…';
      try {
        const res = await adminApi('/api/admin/stats/summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ month: stat.month }),
        });
        if (!res.ok) throw new Error('network');
        const fresh = await res.json();
        toast(fresh.ai ? 'Мнение месяца написал ИИ — страница обновится через минуту.' : 'ИИ недоступен, вставил шаблонное мнение из цифр.');
        await renderAdminStats();
      } catch {
        toast('Не получилось написать мнение. Попробуйте ещё раз.');
        summaryBtn.disabled = false;
        summaryBtn.textContent = 'написать мнение';
      }
    },
  }, 'написать мнение');

  listEl.append(el('div', { class: 'stats-controls' }, [select, refreshBtn, pageLink, summaryBtn]));

  // аналитическая заметка месяца — то, что видно на его странице
  if (stat.summary) {
    const summary = el('textarea', { class: 'stats-post', rows: '8', readonly: true, spellcheck: 'false' });
    summary.value = stat.summary;
    listEl.append(el('p', { class: 'admin-hint', text: 'Мнение месяца на странице /itogi/' + stat.month + ':' }));
    listEl.append(summary);
  }

  // готовый текст поста
  const post = el('textarea', { class: 'stats-post', rows: '16', readonly: true, spellcheck: 'false' });
  post.value = stat.post || '';
  listEl.append(el('p', { class: 'admin-hint', text: 'Текст для поста в канал — копируйте как есть:' }));
  listEl.append(post);
  listEl.append(el('div', { class: 'cta-row' }, [
    el('button', {
      class: 'btn btn-ink',
      type: 'button',
      onclick: () => copyText(post.value, {
        ok: 'Текст поста скопирован — вставляйте в канал.',
        fail: 'Скопировать не получилось: выделите текст в поле и скопируйте вручную.',
      }),
    }, 'скопировать текст'),
    el('a', { class: 'btn btn-line', href: '/itogi', target: '_blank', rel: 'noopener' }, 'страница итогов'),
  ]));

  // цифры месяца
  const price = stat.prices || [];
  const rows = price.map((p) => el('tr', {}, [
    el('th', { scope: 'row', text: currencyWordRu(p.currency) }),
    el('td', { class: 'mono', text: fmtMoney(p.avg) }),
    el('td', { class: 'mono', text: p.min === p.max ? '—' : `${fmtMoney(p.min)}–${fmtMoney(p.max)}` }),
    el('td', { class: 'mono', text: String(p.count) }),
  ]));
  listEl.append(el('table', { class: 'stats-table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'валюта' }), el('th', { text: 'средняя цена' }),
      el('th', { text: 'от и до' }), el('th', { text: 'объявлений' }),
    ])]),
    el('tbody', {}, rows),
  ]));
  if (price.length === 0) {
    listEl.append(el('p', { class: 'empty-note', text: 'Цену в этом месяце никто не указал.' }));
  }
  listEl.append(el('p', {
    class: 'admin-hint',
    text: `${stat.cities} городов · ${stat.directions} направлений · из чатов ${stat.fromChats}, с сайта ${stat.fromSite} · бесплатно ${stat.free}.`,
  }));
  const tops = stat.topDirections || [];
  if (tops.length) {
    listEl.append(el('p', {
      class: 'admin-hint',
      text: `Топ направлений: ${tops.map((d) => `${d.pair} (${d.count})`).join(', ')}.`,
    }));
  }
  listEl.append(el('p', {
    class: 'admin-hint',
    text: 'Прошлые месяцы сохраняются снимком: удаление старого архива цифры не меняет. Ночной cron пересчитывает текущий месяц сам.',
  }));
}

/** '2026-09' → 'сентябрь 2026' — подпись месяца в админке. */
function fmtPeriodRu(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return period || '';
  const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const name = names[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : period;
}

function currencyWordRu(code) {
  return {
    EUR: 'евро', PLN: 'злотых', USD: 'долларов', BYN: 'белорусских рублей',
    RUB: 'российских рублей', UAH: 'гривен', GBP: 'фунтов', CZK: 'чешских крон',
    none: 'валюта не указана',
  }[code] || code;
}

function fmtMoney(n) {
  const r = Math.round(Number(n) * 10) / 10;
  return String(r).replace('.', ',');
}

function switchAdminTab(tab) {
  adminTab = tab;
  $('#admin-tab-pending').classList.toggle('on', tab === 'pending');
  $('#admin-tab-board').classList.toggle('on', tab === 'board');
  $('#admin-tab-chats').classList.toggle('on', tab === 'chats');
  $('#admin-tab-match').classList.toggle('on', tab === 'match');
  $('#admin-tab-dupes').classList.toggle('on', tab === 'dupes');
  $('#admin-tab-stats').classList.toggle('on', tab === 'stats');
  loadAdmin();
}

async function adminSetStatus(id, status) {
  try {
    const res = await adminApi(`/api/admin/listings/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json().catch(() => ({}));
    const labels = { published: 'Опубликовано.', rejected: 'Отклонено.', expired: 'Отправлено в архив.' };
    // Сервер проверяет дубли и при публикации: вдруг такая заявка уже на доске
    toast(data.duplicate && data.duplicate.id
      ? `${labels[status] || 'Готово.'} Но на доске уже есть такая заявка № ${data.duplicate.id.slice(0, 8)} — проверьте, не дубль ли.`
      : (labels[status] || 'Готово.'));
    // Список не перезагружаем: карточка уходит на месте, прокрутка и открытые
    // «связи» соседних заявок остаются как были.
    if (adminTab === 'pending') {
      dropAdminCard(id);
    } else {
      const item = adminItems.find((x) => x.id === id);
      if (item) {
        item.status = status;
        rerenderAdminCard(item);
      } else {
        await loadAdmin();
      }
    }
  } catch {
    toast('Не получилось. Попробуйте ещё раз.');
  }
}

function bindAdmin() {
  $('#admin-tab-pending').addEventListener('click', () => switchAdminTab('pending'));
  $('#admin-tab-board').addEventListener('click', () => switchAdminTab('board'));
  $('#admin-tab-chats').addEventListener('click', () => switchAdminTab('chats'));
  $('#admin-tab-match').addEventListener('click', () => switchAdminTab('match'));
  $('#admin-tab-dupes').addEventListener('click', () => switchAdminTab('dupes'));
  $('#admin-tab-stats').addEventListener('click', () => switchAdminTab('stats'));
  $('#admin-key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('#admin-key').value.trim();
    if (!key) return;
    localStorage.setItem(ADMIN_KEY_STORAGE, key);
    loadAdmin();
  });
  $('#admin-refresh').addEventListener('click', () => loadAdmin());
  $('#admin-logout').addEventListener('click', () => {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
    $('#admin-key').value = '';
    loadAdmin();
  });
}

/* ---------- шапка и прочее ---------- */

function setToday() {
  const now = new Date();
  $('#today').textContent = `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS_SHORT[now.getMonth()]}`;
}

let chatLinks = {}; // публичные ссылки на чаты-источники (id чата → t.me/…)

async function init() {
  setToday();
  bindBoard();
  bindForm();
  bindAdmin();

  // Сервер вставил объявления и карточку прямо в HTML (src/ssr.ts) и передал
  // данные сюда: кладём их в кэш, чтобы первый же клик открыл карточку без
  // запроса, и показываем счётчик, не дожидаясь API.
  const ssr = window.__SSR__;
  if (ssr) {
    if (Array.isArray(ssr.items)) cacheListings(ssr.items);
    if (ssr.item) cacheListings([ssr.item]);
    if (typeof ssr.total === 'number') {
      state.total = ssr.total;
      $('#total-count').textContent = `${ssr.total} ${plural(ssr.total, 'объявление', 'объявления', 'объявлений')}`;
    }
  }

  try {
    const res = await api('/api/config');
    config = await res.json();
  } catch { /* оставляем дефолт */ }

  try {
    const res = await api('/api/chat-links');
    const data = await res.json();
    chatLinks = data.links || {};
  } catch { /* без ссылок — подписи просто не кликабельны */ }

  if (config.botLink) {
    $('#nav-bot').hidden = false;
    $('#bot-link').href = config.botLink;
    $('#foot-bot').href = config.botLink;
    $('#foot-bot').target = '_blank';
  } else {
    $('#bot-link').href = '/bot';
  }

  await route();
}

init();
