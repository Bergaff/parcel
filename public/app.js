/* Попутная — клиентская логика (vanilla JS, без сборки). */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  type: '',
  from: '',
  to: '',
  date: '',
  page: 1,
  hasMore: false,
  items: [],
};

let config = { siteName: 'Попутная', botUsername: null, botLink: null };

/* ---------- helpers ---------- */

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
  t._timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function fmtNumber(n) {
  if (n == null) return '';
  return String(n).replace('.', ',');
}

function contactHref(listing) {
  if (listing.telegram) {
    const u = listing.telegram.replace(/^@/, '').trim();
    return `https://t.me/${u}`;
  }
  if (listing.phone) return `tel:${listing.phone.replace(/\s/g, '')}`;
  return null;
}

function contactLabel(listing) {
  if (listing.telegram) return listing.telegram;
  if (listing.phone) return listing.phone;
  return null;
}

/* ---------- routing ---------- */

function showView(name) {
  for (const v of ['list', 'new', 'item', 'bot']) {
    $(`#view-${v}`).hidden = v !== name;
  }
  window.scrollTo({ top: 0 });
}

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/');
  if (parts[0] === 'new') return { view: 'new' };
  if (parts[0] === 'item' && parts[1]) return { view: 'item', id: parts[1] };
  if (parts[0] === 'bot') return { view: 'bot' };
  return { view: 'list' };
}

async function route() {
  const r = parseHash();
  if (r.view === 'new') { showView('new'); }
  else if (r.view === 'bot') { showView('bot'); }
  else if (r.view === 'item') {
    showView('item');
    await loadDetail(r.id);
  } else {
    showView('list');
    await loadList(true);
  }
}

window.addEventListener('hashchange', route);

/* ---------- list ---------- */

function buildCard(l) {
  const card = el('article', { class: 'listing-card onitem', tabindex: '0', role: 'button' }, [
    el('div', { class: 'lc-top' }, [
      el('div', { class: 'lc-route' }, [
        `${l.type === 'offer' ? '🚚' : '📦'} `,
        el('span', { text: l.fromCity }),
        el('span', { class: 'arrow', text: '→' }),
        el('span', { class: 'to', text: l.toCity }),
      ]),
      el('span', { class: `badge badge-${l.type}`, text: l.type === 'offer' ? 'Водитель везёт' : 'Нужно передать' }),
    ]),
    el('div', { class: 'lc-meta' }, [
      l.departureDate ? el('span', { text: `🗓 ${fmtDate(l.departureDate)}` }) : null,
      l.weightKg != null ? el('span', { text: `⚖️ ${fmtNumber(l.weightKg)} кг` }) : null,
      l.price ? el('span', { text: `💶 ${l.price}` }) : null,
    ].filter(Boolean)),
    el('div', { class: 'lc-desc', text: l.description }),
    el('div', { class: 'lc-bottom' }, [
      el('span', { class: 'lc-source', text: l.source === 'telegram' ? (l.sourceChat ? `📡 из чата «${l.sourceChat}»` : '📡 из Telegram') : '🌐 с сайта' }),
      (() => {
        const href = contactHref(l);
        const label = contactLabel(l);
        return href && label
          ? el('a', { class: 'lc-contact', href, target: '_blank', rel: 'noopener', text: `Связаться: ${label}` })
          : null;
      })(),
    ]),
  ]);

  card.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    location.hash = `#/item/${l.id}`;
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') location.hash = `#/item/${l.id}`;
  });
  return card;
}

async function loadList(reset = false) {
  if (reset) { state.page = 1; $('#list').replaceChildren(); }
  const params = new URLSearchParams();
  if (state.type) params.set('type', state.type);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.date) params.set('date', state.date);
  params.set('page', String(state.page));

  $('#list').replaceChildren(el('p', { class: 'empty', text: 'Загружаем…' }));
  try {
    const res = await fetch(`/api/listings?${params}`);
    if (!res.ok) throw new Error('Ошибка загрузки');
    const data = await res.json();
    state.hasMore = data.hasMore;
    const listEl = $('#list');
    if (state.page === 1) listEl.replaceChildren();
    for (const l of data.items) listEl.append(buildCard(l));
    $('#list-empty').hidden = data.items.length > 0;
    $('#load-more').hidden = !data.hasMore;
  } catch (e) {
    $('#list').replaceChildren(el('p', { class: 'empty', text: 'Не удалось загрузить объявления. Попробуйте обновить страницу.' }));
  }
}

function bindFilters() {
  $$('input[name="type"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      state.type = radio.value;
      loadList(true);
    });
  });

  let timer;
  const debounce = (fn) => (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(e), 400);
  };

  $('#f-from').addEventListener('input', debounce((e) => { state.from = e.target.value.trim(); loadList(true); }));
  $('#f-to').addEventListener('input', debounce((e) => { state.to = e.target.value.trim(); loadList(true); }));
  $('#f-date').addEventListener('change', (e) => { state.date = e.target.value; loadList(true); });

  $('#f-clear').addEventListener('click', () => {
    state.type = ''; state.from = ''; state.to = ''; state.date = '';
    $$('input[name="type"]').forEach((r) => { r.checked = r.value === ''; });
    $('#f-from').value = ''; $('#f-to').value = ''; $('#f-date').value = '';
    loadList(true);
  });

  $('#load-more').addEventListener('click', async () => {
    state.page += 1;
    await loadList(false);
  });
}

/* ---------- detail ---------- */

async function loadDetail(id) {
  const box = $('#item-detail');
  box.replaceChildren(el('p', { class: 'empty', text: 'Загружаем…' }));
  try {
    const res = await fetch(`/api/listings/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error();
    const { item: l } = await res.json();

    const contact = contactHref(l);
    const actions = [];
    if (contact) {
      const label = l.telegram ? `Написать в Telegram: ${l.telegram}` : `Позвонить: ${l.phone}`;
      actions.push(el('a', { class: 'btn btn-primary btn-lg', href: contact, target: '_blank', rel: 'noopener', text: label }));
    }
    actions.push(el('button', { class: 'btn btn-ghost', text: 'Скрыть объявление', onclick: () => openReport(l.id) }));

    box.replaceChildren(
      el('div', { class: 'lc-top' }, [
        el('div', { class: 'detail-route' }, [
          l.fromCity,
          el('span', { class: 'arrow', text: '→' }),
          l.toCity,
        ]),
        el('span', { class: `badge badge-${l.type}`, text: l.type === 'offer' ? 'Водитель везёт' : 'Нужно передать' }),
      ]),
      el('div', { class: 'detail-meta' }, [
        l.departureDate ? el('div', { class: 'cell' }, [el('b', { text: 'Дата' }), el('span', { text: fmtDate(l.departureDate) })]) : null,
        l.weightKg != null ? el('div', { class: 'cell' }, [el('b', { text: 'Вес' }), el('span', { text: `${fmtNumber(l.weightKg)} кг` })]) : null,
        l.price ? el('div', { class: 'cell' }, [el('b', { text: 'Цена / оплата' }), el('span', { text: l.price })]) : null,
        l.source === 'telegram' ? el('div', { class: 'cell' }, [el('b', { text: 'Источник' }), el('span', { text: `Telegram${l.sourceChat ? ` · ${l.sourceChat}` : ''}` })]) : null,
      ].filter(Boolean)),
      el('div', { class: 'detail-desc', text: l.description }),
      el('div', { class: 'detail-actions' }, actions),
      el('p', {
        class: 'hint',
        text: 'Проверяйте информацию самостоятельно. Передача посылки — на ваш риск.',
      }),
    );
  } catch {
    box.replaceChildren(
      el('p', { class: 'empty', text: 'Объявление не найдено или было скрыто модерацией.' }),
      el('a', { class: 'back-link', href: '#/', text: '← К списку' }),
    );
  }
}

let reportReason = '';
function openReport(id) {
  reportReason = '';
  const reason = window.prompt('Почему объявление стоит скрыть? (например: мошенник, уже передано)', '');
  if (reason === null) return;
  reportReason = reason;
  submitReport(id);
}

async function submitReport(id) {
  try {
    const res = await fetch(`/api/listings/${encodeURIComponent(id)}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reportReason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'fail');
    toast(data.message || 'Жалоба принята, спасибо.');
  } catch {
    toast('Не удалось отправить жалобу. Попробуйте позже.');
  }
}

/* ---------- form ---------- */

function bindForm() {
  const form = $('#form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    err.hidden = true;

    const fd = new FormData(form);
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
      err.textContent = 'Укажите хотя бы один контакт: Telegram или телефон.';
      err.hidden = false;
      return;
    }

    const btn = $('#submit-btn');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';

    try {
      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        const fieldError = data.error && typeof data.error === 'string'
          ? data.error
          : 'Не удалось отправить объявление. Проверьте поля.';
        throw new Error(fieldError);
      }
      toast(data.message || 'Готово!');
      form.reset();
      location.hash = '#/';
      await loadList(true);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отправить на модерацию';
    }
  });
}

/* ---------- init ---------- */

async function init() {
  bindFilters();
  bindForm();

  try {
    const res = await fetch('/api/config');
    config = await res.json();
  } catch { /* дефолт */ }

  if (config.botUsername && config.botLink) {
    $('#nav-bot').hidden = false;
    $('#hero-bot').hidden = false;
    $('#bot-link').href = config.botLink;
  } else {
    $('#bot-link').href = '#/';
  }

  await route();
}

init();
