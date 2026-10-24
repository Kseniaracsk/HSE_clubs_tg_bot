// ============================================================
//  ОБЩИЙ ФАЙЛ - подключается на каждой странице внизу
//  тут всё что нужно везде: телеграм, запросы к серверу,
//  меню снизу, звёздочки подписок и прочая мелочь
// ============================================================

// ---------- подключаемся к телеграму ----------
// по документации сначала надо вызвать ready(), иначе ничего не работает
// (я так и не понял почему, но работает только с ним)
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();  // говорим телеграму что мы загрузились
  tg.expand(); // растягиваем наш апп на весь экран
  if (tg.setHeaderColor) tg.setHeaderColor('#2438b8');     // шапка синяя как в макете
  if (tg.setBackgroundColor) tg.setBackgroundColor('#efeff4'); // фон серенький
}

// ---------- тут мы просим данные у сервера ----------
// адрес всегда типа /api/clubs
// x-init-data - это телеграм сам нам его выдал, сервер по нему понимает кто мы
async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: {
      'Content-Type': 'application/json',
      'x-init-data': tg && tg.initData ? tg.initData : '',
    },
    ...options,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ошибка запроса');
  return res.json();
}

// ---------- мелкие полезные функции ----------

// превращаем < > и кавычки в спецсимволы, чтобы всякая дрянь не сломала страницу
// (нам про это рассказывали на лекции по безопасности)
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Публичные внешние ссылки и контакты читаются из SQLite через /api/app-info.
function safeExternalUrl(value, allowMailTel = false) {
  try {
    const url = new URL(String(value || '').trim());
    const allowed = allowMailTel ? ['http:', 'https:', 'mailto:', 'tel:'] : ['http:', 'https:'];
    return allowed.includes(url.protocol) ? url.href : '';
  } catch (_) { return ''; }
}
function renderConfiguredLinks(container, siteLinks, section) {
  if (!container) return;
  const rows = (Array.isArray(siteLinks) ? siteLinks : []).filter(item => item && (item.section === 'all' || item.section === section));
  container.innerHTML = rows.map(item => {
    const url = safeExternalUrl(item.url);
    if (!url) return '';
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.label || item.key || 'Ссылка')} <span class="chev">${I.chev}</span></a>`;
  }).join('') || '<div class="empty-state">Ссылки пока не добавлены.</div>';
}
function renderConfiguredContacts(container, contacts) {
  if (!container) return;
  const rows = (Array.isArray(contacts) ? contacts : []).filter(Boolean);
  container.innerHTML = rows.map(contact => {
    const links = [];
    const tgUrl = safeExternalUrl(contact.telegramUrl || (contact.telegramUsername ? `https://t.me/${String(contact.telegramUsername).replace(/^@/, '')}` : ''));
    if (tgUrl) links.push(`<a href="${esc(tgUrl)}" target="_blank" rel="noopener noreferrer">Telegram${contact.telegramUsername ? ' @' + esc(String(contact.telegramUsername).replace(/^@/, '')) : ''} <span class="chev">${I.chev}</span></a>`);
    const email = String(contact.email || '').trim();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) links.push(`<a href="mailto:${esc(email)}">${esc(email)} <span class="chev">${I.chev}</span></a>`);
    const phone = String(contact.phone || '').trim();
    if (phone && /^[+()\d\s.-]{6,}$/.test(phone)) links.push(`<a href="tel:${esc(phone.replace(/[^+\d]/g, ''))}">${esc(phone)} <span class="chev">${I.chev}</span></a>`);
    return `<div class="configured-contact"><div class="configured-contact-name">${esc(contact.name || 'Контакт администрации')}</div>${contact.roleTitle ? `<div class="configured-contact-role">${esc(contact.roleTitle)}</div>` : ''}<div class="links-list">${links.join('') || '<span class="empty-state">Способ связи не указан.</span>'}</div></div>`;
  }).join('') || '<div class="empty-state">Контакты администрации пока не добавлены.</div>';
}
async function loadPublicAppInfo() {
  const info = await api('/app-info');
  renderConfiguredLinks(document.getElementById('site-links-profile'), info.siteLinks, 'profile');
  renderConfiguredLinks(document.getElementById('site-links-about'), info.siteLinks, 'about');
  renderConfiguredContacts(document.getElementById('admin-contacts-profile'), info.adminContacts);
  renderConfiguredContacts(document.getElementById('admin-contacts-about'), info.adminContacts);
  return info;
}

// окошко с сообщением снизу экрана, вместо некрасивого alert
let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// вибрация. мелочь, а приятно
function haptic(type = 'light') {
  try {
    if (!tg || !tg.HapticFeedback) return;
    tg.HapticFeedback.impactOccurred(type);
  } catch (_) { /* некоторые клиенты не умеют - просто пропускаем */ }
}

// «сигнальная» вибрация: success / error / warning (notificationOccurred)
function notify(type = 'success') {
  try {
    if (!tg || !tg.HapticFeedback) return;
    tg.HapticFeedback.notificationOccurred(type);
  } catch (_) { /* см. haptic */ }
}

// ---------- иконки ----------
// svg иконки, взял с сайта icons8 и немножко подправил
const I = {
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  search: (c) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
  star: '<svg width="22" height="22" viewBox="0 0 24 24" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.6l-5.8 3 1.1-6.4L2.6 9.6l6.5-.9L12 2.8z"/></svg>',
  starFill: '<svg width="22" height="22" viewBox="0 0 24 24" fill="#f7a21b"><path d="M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.6l-5.8 3 1.1-6.4L2.6 9.6l6.5-.9L12 2.8z"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>',
  chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8e8e93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2438b8" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  tg: '<svg width="22" height="22" viewBox="0 0 24 24" fill="#2438b8"><path d="M21.9 4.6l-3.1 14.7c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9L18 6.5c.4-.3-.1-.5-.6-.2L6.7 13.1 2.1 11.7c-1-.3-1-1 .2-1.5L20.5 3.1c.8-.3 1.6.2 1.4 1.5z"/></svg>',
  share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.6 10.7l6.8-3.4M8.6 13.3l6.8 3.4"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.1"/></svg>',
  calendar: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
};

// ---------- проверка: а точно ли юзер заходил через login.html? ----------
// после входа мы записываем флажок в localStorage браузера
// если флажка нет - выкидываем на страницу входа
// login.html не проверяем, иначе будет вечный круг :)
if (!localStorage.getItem('hse_user') && !location.pathname.endsWith('login.html')) {
  location.href = 'login.html';
}

// ---------- аватарка юзера ----------
// если в телеграме стоит фотка - телеграм сам даёт ссылку на неё (photo_url)
// если фотки нет - ставим нашу аву из папки icons
function getAvaUrl() {
  const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  // у пользователей с несколькими аватарками photo_url из initData бывает
  // битым или отсутствует — сервер сам достанет актуальное фото через Bot API
  if (user && user.id) return `/api/avatar?user=${Number(user.id)}`;
  return 'icons/ava.png';
}

// выйти (кнопка в профиле): стираем флажок и на страницу входа
function logout() {
  localStorage.removeItem('hse_user');
  localStorage.removeItem('hse_role');
  location.href = 'login.html';
}

// ---------- данные которые нужны почти на каждой странице ----------
const state = {
  categories: [],  // все категории (грузятся с сервера)
  clubSubs: [],    // номера клубов на которые подписан юзер
  categorySubs: [],// подписки на категории
  mutedClubs: [],  // клубы с выключенными уведомлениями
};

// грузим категории и подписки юзера
// вызывается на каждой странице перед отрисовкой
async function loadBase() {
  if (!state.categories.length) state.categories = await api('/categories');
  const subs = await api('/subscriptions').catch(() => null); // если сервер лежит - не падаем
  if (subs) {
    state.clubSubs = subs.clubs.map((c) => c.id);
    state.categorySubs = subs.categorySubs;
    state.mutedClubs = subs.mutedClubs;
  }
}

// ---------- звёздочка подписки ----------
// рисует кнопочку: если подписан - залитая оранжевая, если нет - контурная
function starBtn(clubId) {
  const on = state.clubSubs.includes(clubId);
  return `<button class="star-btn${on ? ' active' : ''}" data-sub-toggle="${clubId}" aria-label="Подписка">${on ? I.starFill : I.star}</button>`;
}

// вешаем обработчики на все звёздочки
// НАДО вызывать каждый раз после того как вставили новый html на страницу,
// иначе кнопки не кликаются (ловил этот баг часа два)
function bindCommon(root = document) {
  root.querySelectorAll('[data-sub-toggle]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation(); // чтобы не сработала ссылка под кнопкой
      const id = Number(btn.dataset.subToggle);
      const { subscribed } = await api(`/subscriptions/${id}/toggle`, { method: 'POST' });
      if (subscribed) {
        if (!state.clubSubs.includes(id)) state.clubSubs.push(id);
      } else {
        state.clubSubs = state.clubSubs.filter((x) => x !== id);
      }
      // Обновляем только нажатую звёздочку. Не вызываем renderPage():
      // на некоторых страницах этой функции нет, а карточки уже отрисованы.
      btn.classList.toggle('active', subscribed);
      btn.innerHTML = subscribed ? I.starFill : I.star;
      haptic('medium');
      toast(subscribed ? 'Вы подписались на клуб' : 'Вы отписались от клуба');
    });
  });
}

// ---------- меню снизу ----------
// иконки для меню лежат в папке icons, для каждой есть 2 варианта:
// _orange - если мы сейчас на этой странице, _gray - если не на ней
// например icons/home_orange.svg и icons/home_gray.svg
const NAV_ICONS = {
  home: 'home',       // главная - домик
  catalog: 'lupa',    // каталог - лупа
  events: 'rupor',    // события - рупор
  subs: 'star',       // подписки - звезда
  profile: 'profile', // профиль - человечек
};

// у каждой страницы в body написано data-page, по этому и подсвечиваем
(function initNav() {
  const page = document.body.dataset.page || '';
  const map = {
    home: 'index.html',
    catalog: 'catalog.html',
    events: 'events.html',
    subs: 'subs.html',
    profile: 'profile.html',
  };
  document.querySelectorAll('.nav-item').forEach((btn) => {
    const name = NAV_ICONS[btn.dataset.page];
    const isCurrent = btn.dataset.page === page;

    // вставляем иконку нужного цвета: оранжевую для текущей, серую для остальных
    const ico = btn.querySelector('.nav-icon');
    if (ico) ico.innerHTML = `<img src="icons/${name}_${isCurrent ? 'orange' : 'gray'}.svg" alt="">`;

    if (isCurrent) btn.classList.add('active'); // чтобы подпись была оранжевая

    btn.addEventListener('click', () => {
      haptic('light');
      location.href = map[btn.dataset.page];
    });
  });
})();
