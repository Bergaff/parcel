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

/* ---------- скопировать ссылку на объявление ---------- */

/* Ссылка ведёт на воркер: там /item/:id отдаёт страницу с OG-разметкой,
   поэтому в мессенджерах появляется превью с маршрутом и описанием. */
function shareUrlFor(l) {
  const base = (API_BASE === '' ? location.origin : API_BASE).replace(/\/+$/, '');
  return `${base}/item/${l.id}`;
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
  for (const v of ['list', 'item', 'new', 'how', 'bot', 'terms', 'privacy', 'admin']) {
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
    admin: 'попутка. админ',
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
  if (parts[0] === 'admin') return { view: 'admin' };
  return { view: 'list' };
}

async function route() {
  const r = parseHash();
  if (r.view === 'new') showView('new');
  else if (r.view === 'how') showView('how');
  else if (r.view === 'bot') showView('bot');
  else if (r.view === 'terms') showView('terms');
  else if (r.view === 'privacy') showView('privacy');
  else if (r.view === 'admin') { showView('admin'); await loadAdmin(); }
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
   el('a', { class: 'write-link share-link', text: 'скопировать', onclick: (e) => { e.preventDefault(); e.stopPropagation(); copyListingLink(l); } }),
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

/* Сегодняшняя дата YYYY-MM-DD по Москве/Минску (UTC+3) — день выезда сравниваем с ней */
function mskTodayIso() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ---------- карточка ---------- */

async function loadDetail(id) {
  const box = $('#item-detail');
  box.replaceChildren(el('p', { class: 'empty-note', text: 'достаю карточку…' }));
  try {
    const res = await api(`/api/listings/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('not found');
    const { item: l } = await res.json();
    // Дата поездки прошла — заявка в архиве (месяц ещё доступна, потом удаляется)
    const archived =
      l.status === 'expired' ||
      (l.departureDate != null && l.departureDate < mskTodayIso());

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

/* ---------- админ-панель ---------- */

const ADMIN_KEY_STORAGE = 'popoutka_admin_key';
let adminTab = 'pending'; // 'pending' | 'board'
let adminEditId = null; // id заявки, открытой на редактирование

function adminKey() { return localStorage.getItem(ADMIN_KEY_STORAGE) || ''; }

async function adminApi(path, options = {}) {
  return api(path, {
    ...options,
    headers: { Authorization: `Bearer ${adminKey()}`, ...(options.headers || {}) },
  });
}

function adminCard(l, mode = 'pending') {
  const contact = contactInfo(l);
  const meta = [
    el('span', { text: ago(l.publishedAt || l.createdAt) }),
    l.departureDate ? el('span', { text: `выезд ${fmtDate(l.departureDate)}` }) : null,
    l.weightKg != null ? el('span', { class: 'mono', text: `${String(l.weightKg).replace('.', ',')} кг` }) : null,
    l.price ? el('span', { class: 'mono', text: l.price }) : null,
    el('span', { class: 'src', text: sourceLabel(l) }),
  ];
  const editBtn = el('button', {
    class: 'btn btn-line btn-sm',
    text: adminEditId === l.id ? 'закрыть' : 'редактировать',
    onclick: () => { adminEditId = adminEditId === l.id ? null : l.id; loadAdmin(); },
  });
  const actions = mode === 'pending'
    ? [
        el('button', { class: 'btn btn-ink btn-sm', text: 'одобрить', onclick: () => adminSetStatus(l.id, 'published') }),
        el('button', { class: 'btn btn-line btn-sm', text: 'отклонить', onclick: () => adminSetStatus(l.id, 'rejected') }),
        editBtn,
      ]
    : [
        editBtn,
        l.status === 'expired'
          ? el('button', { class: 'btn btn-ink btn-sm', text: 'на доску', onclick: () => adminSetStatus(l.id, 'published') })
          : el('button', { class: 'btn btn-line btn-sm', text: 'в архив', onclick: () => adminSetStatus(l.id, 'expired') }),
        el('button', { class: 'btn btn-line btn-sm danger', text: 'удалить', onclick: () => adminDelete(l.id) }),
      ];
  return el('article', { class: 'admin-card' }, [
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
      : el('p', { class: 'admin-contact', text: 'контакт не указан' }),
    ...(adminEditId === l.id ? [adminEditForm(l)] : []),
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
      field('Telegram', input('telegram', l.telegram ?? '')),
      field('Телефон', input('phone', l.phone ?? '')),
    ]),
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
      toast('Сохранено.');
      await loadAdmin();
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
    const { items } = await res.json();
    $('#admin-count').textContent = adminTab === 'pending'
      ? (items.length === 0
          ? '✅ Необработанных заявок нет.'
          : `⏳ Необработано заявок: ${items.length}`)
      : (items.length === 0
          ? 'На доске пока пусто.'
          : `На доске: ${items.length} — действующие и архив`);
    const listEl = $('#admin-list');
    listEl.replaceChildren();
    if (items.length === 0) {
      listEl.append(el('p', {
        class: 'empty-note',
        text: adminTab === 'pending' ? 'Очередь пуста. Новые заявки появятся здесь.' : 'На доске ничего нет.',
      }));
    } else {
      for (const l of items) listEl.append(adminCard(l, adminTab));
    }
  } catch {
    $('#admin-list').replaceChildren(el('p', { class: 'empty-note', text: 'Не получилось загрузить. Проверьте связь и нажмите «обновить».' }));
  }
}

async function adminDelete(id) {
  if (!window.confirm('Удалить объявление навсегда? Вместе с жалобами.')) return;
  try {
    const res = await adminApi(`/api/admin/listings/${encodeURIComponent(id)}/delete`, { method: 'POST' });
    if (!res.ok) throw new Error();
    toast('Удалено.');
    await loadAdmin();
  } catch {
    toast('Не получилось удалить. Попробуйте ещё раз.');
  }
}

function switchAdminTab(tab) {
  adminTab = tab;
  $('#admin-tab-pending').classList.toggle('on', tab === 'pending');
  $('#admin-tab-board').classList.toggle('on', tab === 'board');
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
    const labels = { published: 'Опубликовано.', rejected: 'Отклонено.', expired: 'Отправлено в архив.' };
    toast(labels[status] || 'Готово.');
    await loadAdmin();
  } catch {
    toast('Не получилось. Попробуйте ещё раз.');
  }
}

function bindAdmin() {
  $('#admin-tab-pending').addEventListener('click', () => switchAdminTab('pending'));
  $('#admin-tab-board').addEventListener('click', () => switchAdminTab('board'));
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

async function init() {
  setToday();
  bindBoard();
  bindForm();
  bindAdmin();

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
