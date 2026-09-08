/* попутка. клиентская часть. Без фреймворков, без сборки. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  type: '',
  from: '',
  to: '',
  date: '',
  page: 1,
  hasMore: false,
  total: 0,
};

let config = { siteName: 'попутка.', botUsername: null, botLink: null };

/* Адрес воркера с API.
   Пустая строка = API на том же домене (локальная разработка или один воркер с Assets).
   Если Pages и Worker на разных доменах, укажите адрес воркера:
   */
   window.POPUTKA_API_BASE = "https://parcel.tgmg.workers.dev";

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
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function fmtFullDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function ago(iso) {
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400 && d.getDate() === new Date().getDate()) return `сегодня в ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (s < 172800) return 'вчера';
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function contactInfo(l) {
  if (l.telegram) {
    const u = l.telegram.replace(/^@/, '').trim();
    return { href: `https://t.me/${u}`, label: `@${u}` };
  }
  if (l.phone) return { href: `tel:${l.phone.replace(/[^\d+]/g, '')}`, label: l.phone };
  return null;
}

function sourceLabel(l) {
  if (l.source === 'telegram') return l.sourceChat ? `из чата «${l.sourceChat}»` : 'из Telegram';
  return 'с сайта';
}

/* ---------- роутинг ---------- */

function showView(name) {
  for (const v of ['list', 'item', 'new', 'how', 'bot', 'terms', 'privacy']) {
    $(`#view-${v}`).hidden = v !== name;
  }
  const navOn = name === 'how' ? '#/how' : name === 'bot' ? '#/bot' : name === 'list' || name === 'item' ? '#/' : null;
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
  };
  document.title = titles[name] ?? titles.list;
  window.scrollTo({ top: 0 });
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'new') return { view: 'new' };
  if (parts[0] === 'item' && parts[1]) return { view: 'item', id: parts[1] };
  if (parts[0] === 'how') return { view: 'how' };
  if (parts[0] === 'bot') return { view: 'bot' };
  if (parts[0] === 'terms') return { view: 'terms' };
  if (parts[0] === 'privacy') return { view: 'privacy' };
  return { view: 'list' };
}

async function route() {
  const r = parseHash();
  if (r.view === 'new') showView('new');
  else if (r.view === 'how') showView('how');
  else if (r.view === 'bot') showView('bot');
  else if (r.view === 'terms') showView('terms');
  else if (r.view === 'privacy') showView('privacy');
  else if (r.view === 'item') { showView('item'); await loadDetail(r.id); }
  else { showView('list'); await loadList(true); }
}

window.addEventListener('hashchange', route);

/* ---------- доска ---------- */

function buildRow(l) {
  const contact = contactInfo(l);
  const row = el('article', { class: 'row', tabindex: '0', role: 'button' }, [
    el('div', { class: 'row-main' }, [
      el('h3', { class: 'route-line' }, [
        l.fromCity,
        el('span', { class: 'r-arrow', text: '→' }),
        el('span', { class: 'r-to', text: l.toCity }),
      ]),
      el('p', { class: 'desc', text: l.description }),
      el('div', { class: 'meta-line' }, [
        el('span', { text: ago(l.publishedAt || l.createdAt) }),
        l.departureDate ? el('span', { text: `выезд ${fmtDate(l.departureDate)}` }) : el('span', { text: 'дата не указана' }),
        l.weightKg != null ? el('span', { class: 'mono', text: `${String(l.weightKg).replace('.', ',')} кг` }) : null,
        l.price ? el('span', { class: 'mono', text: l.price }) : null,
        el('span', { class: 'src', text: sourceLabel(l) }),
      ].filter(Boolean)),
    ]),
    el('div', { class: 'row-side' }, [
      el('span', { class: `stamp stamp-${l.type}`, text: l.type === 'offer' ? 'водитель везёт' : 'ищу передачу' }),
      contact
        ? el('a', { class: 'write-link', href: contact.href, target: '_blank', rel: 'noopener', text: 'написать' })
        : el('span', { class: 'write-link', style: 'cursor:default', text: 'контакт в карточке' }),
      el('span', { class: 'row-no', text: `№ ${l.id.slice(0, 4).toUpperCase()}` }),
    ]),
  ]);

  const open = () => { location.hash = `#/item/${l.id}`; };
  row.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    open();
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return row;
}

async function loadList(reset = false) {
  if (reset) state.page = 1;
  const params = new URLSearchParams();
  if (state.type) params.set('type', state.type);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.date) params.set('date', state.date);
  params.set('page', String(state.page));

  if (state.page === 1) $('#list').replaceChildren(el('p', { class: 'empty-note', text: 'смотрю доску…' }));

  try {
    const res = await api(`/api/listings?${params}`);
    if (!res.ok) throw new Error('network');
    const data = await res.json();
    state.hasMore = data.hasMore;
    state.total = data.total ?? data.items.length;

    const listEl = $('#list');
    if (state.page === 1) listEl.replaceChildren();
    if (data.items.length === 0 && state.page === 1) listEl.replaceChildren();
    for (const l of data.items) listEl.append(buildRow(l));

    $('#total-count').textContent = `${state.total} ${plural(state.total, 'объявление', 'объявления', 'объявлений')}`;
    $('#list-empty').hidden = !(state.total === 0);
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
      state.type = tab.dataset.type;
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

/* ---------- карточка ---------- */

async function loadDetail(id) {
  const box = $('#item-detail');
  box.replaceChildren(el('p', { class: 'empty-note', text: 'достаю карточку…' }));
  try {
    const res = await api(`/api/listings/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('not found');
    const { item: l } = await res.json();

    const contact = contactInfo(l);
    const actions = [];
    if (contact) {
      actions.push(
        el('a', {
          class: 'btn btn-ink btn-lg',
          href: contact.href,
          target: '_blank',
          rel: 'noopener',
          text: l.telegram ? `написать ${contact.label}` : `позвонить ${contact.label}`,
        })
      );
    }
    actions.push(
      el('a', {
        class: 'link-btn',
        href: `#/item/${l.id}`,
        onclick: (e) => { e.preventDefault(); openReport(l.id); },
        text: 'пожаловаться',
      })
    );

    const cells = [];
    if (l.departureDate) {
      cells.push(el('div', { class: 'cell' }, [
        el('span', { class: 'label', text: 'выезд' }),
        el('span', { class: 'value', text: fmtFullDate(l.departureDate) }),
      ]));
    } else {
      cells.push(el('div', { class: 'cell' }, [
        el('span', { class: 'label', text: 'выезд' }),
        el('span', { class: 'value', text: 'дата не указана' }),
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
      el('span', { class: 'value', text: sourceLabel(l) }),
    ]));
    cells.push(el('div', { class: 'cell' }, [
      el('span', { class: 'label', text: 'добавлено' }),
      el('span', { class: 'value', text: ago(l.createdAt) }),
    ]));

    box.replaceChildren(
      el('div', { class: 'd-head' }, [
        el('h2', { class: 'd-route' }, [
          l.fromCity,
          el('span', { class: 'r-arrow', text: '→' }),
          el('span', { class: 'r-to', text: l.toCity }),
        ]),
        el('span', { class: `stamp stamp-${l.type}`, text: l.type === 'offer' ? 'водитель везёт' : 'ищу передачу' }),
      ]),
      el('div', { class: 'd-meta' }, cells),
      el('p', { class: 'd-desc', text: l.description }),
      el('div', { class: 'd-actions' }, actions),
      el('p', {
        class: 'd-note',
        text: 'Объявление проверено модератором, но это не гарантия: связывайтесь с человеком, задавайте вопросы и не передавайте деньги заранее. Опечатка или фейк, нажмите «пожаловаться», разберусь.',
      }),
    );
  } catch {
    box.replaceChildren(
      el('p', { class: 'empty-note', text: 'Такого объявления нет. Возможно, его сняли после жалоб.' }),
      el('a', { class: 'back', href: '#/', text: '← к доске' }),
    );
  }
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'fail');
    toast(data.message || 'Жалоба принята.');
  } catch {
    toast('Не получилось отправить жалобу. Попробуйте позже.');
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
      toast(data.message || 'Ушло на проверку.');
      e.target.reset();
      location.hash = '#/';
      await loadList(true);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отправить на проверку';
    }
  });
}

/* ---------- шапка и прочее ---------- */

function setToday() {
  const now = new Date();
  $('#today').textContent = `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS_SHORT[now.getMonth()]}`;
}

async function init() {
  setToday();
  bindBoard();
  bindForm();

  try {
    const res = await api('/api/config');
    config = await res.json();
  } catch { /* оставляем дефолт */ }

  if (config.botLink) {
    $('#nav-bot').hidden = false;
    $('#bot-link').href = config.botLink;
    $('#foot-bot').href = config.botLink;
    $('#foot-bot').target = '_blank';
  } else {
    $('#bot-link').href = '#/bot';
  }

  await route();
}

init();
