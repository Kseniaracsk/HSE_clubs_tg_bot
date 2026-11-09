'use strict';

// HSE clubs NN — Node.js + SQLite. Клубы, категории, события, пользователи,
// подписки, заявки, уведомления и рассылки хранятся в одной SQLite-базе.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_ACCESS_CODE = process.env.ADMIN_ACCESS_CODE || '';
// Ключ Google Drive API: по нему сервер сам собирает прямые ссылки на фото
// из папок Drive, указанных в БД (обложка + карусель). Без ключа работают заглушки.
const DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY || '';
const SOURCE_DB_FILE = path.join(__dirname, 'hse_nn_clubs.db');
const LEGACY_DB_FILE = process.env.DB_FILE && /\.(?:db|sqlite|sqlite3)$/i.test(process.env.DB_FILE) ? process.env.DB_FILE : '';
const DEFAULT_PERSISTENT_DB = process.env.NODE_ENV === 'production' && fs.existsSync('/data') ? '/data/hse_nn_clubs.db' : SOURCE_DB_FILE;
const DB_FILE = process.env.SQLITE_DB_PATH || LEGACY_DB_FILE || DEFAULT_PERSISTENT_DB;

if (!fs.existsSync(DB_FILE)) {
  if (!fs.existsSync(SOURCE_DB_FILE)) throw new Error(`Не найдена SQLite-база: ${SOURCE_DB_FILE}`);
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.copyFileSync(SOURCE_DB_FILE, DB_FILE);
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
try { db.exec('PRAGMA journal_mode = WAL;'); } catch (_) { /* некоторые хостинги ограничивают режим WAL */ }

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}
function ensureColumn(table, column, declaration) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

// Небольшие поля, нужные Mini App, отсутствовали в исходной схеме.
// Они добавляются миграциями, не удаляя и не перезаписывая существующие записи.
ensureColumn('requests', 'media_json', 'TEXT');
ensureColumn('requests', 'category_id', 'INTEGER');
ensureColumn('requests', 'published_at', 'TEXT');
ensureColumn('requests', 'updated_at', 'TEXT');
ensureColumn('requests', 'created_at', 'TEXT');
ensureColumn('requests', 'reviewed_by', 'INTEGER');
ensureColumn('events', 'event_type', 'TEXT');
ensureColumn('events', 'organizer_contact', 'TEXT');
ensureColumn('broadcasts', 'club_ids_json', 'TEXT');
ensureColumn('broadcasts', 'created_by', 'INTEGER');
ensureColumn('broadcasts', 'updated_at', 'TEXT');
ensureColumn('users', 'last_active_at', 'TEXT');
ensureColumn('users', 'photo_url', 'TEXT');
ensureColumn('users', 'language_code', 'TEXT');
ensureColumn('users', 'is_premium', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'allows_write_to_pm', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'updated_at', 'TEXT');
// Помечаем файл-логотип заявки: при создании клуба он получит имя «Название(значок)».
ensureColumn('request_files', 'is_logo', 'INTEGER NOT NULL DEFAULT 0');

// Эти две таблицы расширяют исходную схему для истории уведомлений и аналитики.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
    club TEXT,
    text TEXT NOT NULL,
    time TEXT,
    at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'general',
    status TEXT,
    telegram_sent INTEGER NOT NULL DEFAULT 0,
    telegram_error TEXT
  );
  CREATE TABLE IF NOT EXISTS user_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'visit'
  );
  CREATE INDEX IF NOT EXISTS idx_clubs_category_active ON clubs(category_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date, event_time);
  CREATE INDEX IF NOT EXISTS idx_requests_user_created ON requests(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_at ON user_activity(at);
  CREATE INDEX IF NOT EXISTS idx_broadcasts_status_schedule ON broadcasts(status, scheduled_at);
`);

// Дополнительные таблицы приложения. Все контакты, внешние ссылки, администраторы,
// попытки входа в админ-режим, журнал действий и история модерации хранятся в SQLite.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    is_public INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS site_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_key TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT 'all',
    sort_order INTEGER NOT NULL DEFAULT 100,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS admin_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role_title TEXT NOT NULL DEFAULT '',
    telegram_username TEXT,
    telegram_url TEXT,
    email TEXT,
    phone TEXT,
    visible_public INTEGER NOT NULL DEFAULT 1,
    is_primary INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS admin_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin',
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_access_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempted_at TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    details_json TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS request_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    previous_status TEXT,
    next_status TEXT,
    comment TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_attempts_user_time ON admin_access_attempts(user_id, attempted_at);
  CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_request_history_request ON request_status_history(request_id, at);
  CREATE INDEX IF NOT EXISTS idx_site_links_section ON site_links(section, is_active, sort_order);
  CREATE INDEX IF NOT EXISTS idx_admin_contacts_public ON admin_contacts(visible_public, is_active, sort_order);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_contacts_single_primary ON admin_contacts(is_primary) WHERE is_primary=1;
`);

// Миграция старых администраторов: роль users.role остаётся для совместимости,
// а admin_accounts хранит отдельную запись о выдаче/отзыве прав.
db.prepare(`INSERT OR IGNORE INTO admin_accounts (user_id, role, granted_at)
  SELECT id, 'admin', COALESCE(created_at, CURRENT_TIMESTAMP) FROM users
  WHERE LOWER(COALESCE(role, '')) IN ('admin', 'administrator')`).run();

// Переносим уже использовавшиеся сайтом публичные ссылки/контакт в БД только при первом запуске.
const seedStamp = new Date().toISOString();
const seedLink = db.prepare(`INSERT OR IGNORE INTO site_links
  (link_key, label, url, section, sort_order, is_active, created_at, updated_at)
  VALUES (?, ?, ?, 'all', ?, 1, ?, ?)`);
seedLink.run('hse_website', 'Сайт НИУ ВШЭ', 'https://www.hse.ru', 10, seedStamp, seedStamp);
seedLink.run('hse_telegram', 'Telegram-канал Вышки', 'https://t.me/hse_nnov', 20, seedStamp, seedStamp);
const seedContact = db.prepare(`INSERT OR IGNORE INTO admin_contacts
  (contact_key, name, role_title, telegram_username, telegram_url, visible_public, is_primary, is_active, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 1, 1, 1, 10, ?, ?)`);
seedContact.run('project_support', 'Администратор HSE clubs NN', 'Обратная связь по Mini App', 'racsk', 'https://t.me/racsk', seedStamp, seedStamp);
const seedSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value, is_public, updated_at) VALUES (?, ?, ?, ?)');
seedSetting.run('project_name', 'HSE clubs NN', 1, seedStamp);
seedSetting.run('project_description', 'Каталог студенческих клубов и событий НИУ ВШЭ в Нижнем Новгороде', 1, seedStamp);

function nowIso() { return new Date().toISOString(); }
function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}
function splitTextList(value) {
  if (!value) return [];
  const parsed = safeJsonParse(value, null);
  if (Array.isArray(parsed)) return parsed.map(x => String(x).trim()).filter(Boolean);
  return String(value).split(/\r?\n/).map(s => s.replace(/^\s*(?:[•*-]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}
function isDirectImageUrl(value) {
  const s = String(value || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (/drive\.google\.com\/(?:drive\/folders|drive\/my-drive|open\?id=)/i.test(s)) return false;
  return /\.(?:png|jpe?g|gif|webp|svg|avif)(?:[?#].*)?$/i.test(s) || /googleusercontent\.com/i.test(s);
}
function isImageSource(value) {
  const s = String(value || '').trim();
  return isDirectImageUrl(s) || /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif);base64,/i.test(s);
}

// ФОТО ИЗ ПАПОК GOOGLE DRIVE
// В БД хранятся ссылки на папки Drive. По ключу DRIVE_API_KEY сервер запрашивает
// список файлов папки и превращает их в прямые ссылки на картинки: первая — обложка,
// остальные попадают в карусель. Результат кэшируется в памяти на 6 часов.
const DRIVE_FOLDER_RE = /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/i;
const DRIVE_CACHE_TTL = 6 * 60 * 60 * 1000;
const driveImageCache = new Map();
const driveInFlight = new Map();

function driveFolderId(url) {
  const match = String(url || '').match(DRIVE_FOLDER_RE);
  return match ? match[1] : '';
}

async function driveFolderImages(folderId) {
  if (!DRIVE_API_KEY || !folderId) return [];
  const cached = driveImageCache.get(folderId);
  if (cached && Date.now() - cached.fetchedAt < DRIVE_CACHE_TTL) return cached.urls;
  if (driveInFlight.has(folderId)) return driveInFlight.get(folderId);
  const task = (async () => {
    try {
      const query = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
      const url = `https://www.googleapis.com/drive/v3/files?q=${query}&key=${DRIVE_API_KEY}&fields=files(id,name)&pageSize=100`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Drive API ответил ${response.status}`);
      const data = await response.json();
      const all = Array.isArray(data.files) ? data.files : [];
      // Конвенция папок клуба: обложка — файл «...(значок)», остальные фото идут по порядку имён.
      const isIcon = file => /\(\s*значок\s*\)/i.test(String(file.name || ''));
      const sorted = [
        ...all.filter(file => isIcon(file)),
        ...all.filter(file => !isIcon(file)).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru', { numeric: true })),
      ];
      const urls = sorted.map(file => `https://lh3.googleusercontent.com/d/${file.id}=w1200`);
      driveImageCache.set(folderId, { urls, fetchedAt: Date.now() });
      return urls;
    } catch (error) {
      console.error(`Не удалось получить фото из папки Drive ${folderId}: ${error.message}`);
      return [];
    } finally {
      driveInFlight.delete(folderId);
    }
  })();
  driveInFlight.set(folderId, task);
  return task;
}

async function hydrateClubImages(club) {
  if (!club) return club;
  const folderIds = [...new Set([club.mainPhotoUrl, ...(club.photoResources || []).map(item => item && item.url)]
    .map(driveFolderId).filter(Boolean))];
  if (!DRIVE_API_KEY || !folderIds.length) return club;
  const resolved = new Map();
  await Promise.all(folderIds.map(async id => resolved.set(id, await driveFolderImages(id))));
  const images = [];
  for (const item of club.photoResources || []) {
    if (item && item.isCover) for (const url of resolved.get(driveFolderId(item.url)) || []) images.push(url);
  }
  for (const id of folderIds) {
    for (const url of resolved.get(id) || []) if (!images.includes(url)) images.push(url);
  }
  if (images.length) club.images = images;
  return club;
}

// СОЗДАНИЕ ПАПОК И ЗАГРУЗКА ФАЙЛОВ НА DRIVE (сервисный аккаунт)
// Ключ сервисного аккаунта — JSON-файл в корне проекта (исключён из git).
// При одобрении клубной заявки сервер сам создаёт папку клуба в корневой папке
// Drive, заливает туда фото из заявки (вместо base64 в БД) и создаёт клуб.
const GOOGLE_SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE
  ? path.resolve(__dirname, process.env.GOOGLE_SERVICE_ACCOUNT_FILE) : '';
const GOOGLE_DRIVE_ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '';
// OAuth-данные владельца Drive: файлы, загруженные через refresh-токен, занимают
// квоту обычного Google-аккаунта (у сервисных аккаунтов квоты нет).
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const GOOGLE_OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '';
let serviceAccount = null;
if (GOOGLE_SERVICE_ACCOUNT_FILE) {
  try {
    serviceAccount = JSON.parse(fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
    console.log(`Сервисный аккаунт Drive подключен: ${serviceAccount.client_email}`);
  } catch (error) {
    console.error(`Не удалось прочитать ключ сервисного аккаунта: ${error.message}`);
  }
}
let driveAccessToken = null;
const b64url = input => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const DATA_URI_RE = /^data:[^,;]+;base64,/i;

async function getDriveAccessToken() {
  if (GOOGLE_OAUTH_REFRESH_TOKEN && GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET) {
    if (driveAccessToken && driveAccessToken.kind === 'oauth' && Date.now() < driveAccessToken.expiresAt - 60_000) {
      return driveAccessToken.value;
    }
    const body = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(`Google OAuth refresh: ${data.error_description || data.error || response.status}`);
    driveAccessToken = { kind: 'oauth', value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
    return driveAccessToken.value;
  }
  if (!serviceAccount) throw new Error('Не настроен ни OAuth, ни сервисный аккаунт Google Drive');
  if (driveAccessToken && driveAccessToken.kind === 'sa' && Date.now() < driveAccessToken.expiresAt - 60_000) {
    return driveAccessToken.value;
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const assertion = `${header}.${payload}.${b64url(signer.sign(serviceAccount.private_key))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google OAuth: ${data.error_description || data.error || response.status}`);
  driveAccessToken = { kind: 'sa', value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return driveAccessToken.value;
}

async function driveApi(method, url, body, headers = {}) {
  const token = await getDriveAccessToken();
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  if (!response.ok) throw new Error(`Drive API ${response.status}: ${(data.error && data.error.message) || text.slice(0, 200)}`);
  return data;
}

// Есть куда и от кого писать: root-папка + (OAuth владельца или сервисный аккаунт).
const canWriteDrive = () => Boolean(GOOGLE_DRIVE_ROOT_FOLDER_ID &&
  (serviceAccount || (GOOGLE_OAUTH_REFRESH_TOKEN && GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET)));

// Scope drive.file даёт доступ только к файлам, созданным приложением. Поэтому
// root-папку из .env приложение может использовать, только если она ему доступна
// (для сервисного аккаунта так и есть). Иначе — свой корневой каталог «HSE Clubs NN»
// в My Drive владельца: создаётся один раз, дальше находится по имени.
const GOOGLE_DRIVE_APP_ROOT_NAME = process.env.GOOGLE_DRIVE_APP_ROOT_NAME || 'HSE Clubs NN';
let appRootFolderId = null;
async function getDriveRootFolderId() {
  if (appRootFolderId) return appRootFolderId;
  if (GOOGLE_DRIVE_ROOT_FOLDER_ID) {
    try {
      const info = await driveApi('GET', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(GOOGLE_DRIVE_ROOT_FOLDER_ID)}?fields=id`);
      if (info && info.id) { appRootFolderId = info.id; return appRootFolderId; }
    } catch (_) { /* папка недоступна приложению — работаем в собственном корне */ }
  }
  const q = encodeURIComponent(`name='${GOOGLE_DRIVE_APP_ROOT_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await driveApi('GET', `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1&orderBy=createdTime`);
  if (found.files && found.files.length) { appRootFolderId = found.files[0].id; return appRootFolderId; }
  const created = await driveApi('POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    JSON.stringify({ name: GOOGLE_DRIVE_APP_ROOT_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    { 'Content-Type': 'application/json; charset=UTF-8' });
  try { await makeDriveFilePublic(created.id); }
  catch (error) { console.error(`Не удалось открыть доступ к корневой папке ${created.id}: ${error.message}`); }
  appRootFolderId = created.id;
  return appRootFolderId;
}

// Файлы по умолчанию приватные: открываем «доступ по ссылке — чтение»,
// иначе lh3-ссылки не показываются, а папка не листается по API-ключу.
async function makeDriveFilePublic(fileId) {
  await driveApi('POST', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=id`,
    JSON.stringify({ role: 'reader', type: 'anyone' }),
    { 'Content-Type': 'application/json; charset=UTF-8' });
}

async function createDriveFolder(name, parentId) {
  const data = await driveApi('POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    JSON.stringify({ name: String(name).trim().slice(0, 120) || 'Новый клуб', mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    { 'Content-Type': 'application/json; charset=UTF-8' });
  try { await makeDriveFilePublic(data.id); }
  catch (error) { console.error(`Не удалось открыть доступ к папке ${data.id}: ${error.message}`); }
  return data.id;
}

async function uploadDriveFile(folderId, fileName, mimeType, dataUrl) {
  const boundary = `hse-${crypto.randomBytes(8).toString('hex')}`;
  const metadata = JSON.stringify({ name: String(fileName || 'photo').slice(0, 120), parents: [folderId] });
  const content = Buffer.from(String(dataUrl).split(',').pop(), 'base64');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const data = await driveApi('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    body, { 'Content-Type': `multipart/related; boundary=${boundary}` });
  try { await makeDriveFilePublic(data.id); }
  catch (error) { console.error(`Не удалось открыть доступ к файлу ${data.id}: ${error.message}`); }
  return data.id;
}

// Одобрение клубной заявки: папка Drive + фото + новый клуб в базе.
async function createClubFromSubmission(submission, adminDbId) {
  const details = safeJsonParse(submission.details, {});
  const name = String(details.title || submission.title || 'Новый клуб').trim().slice(0, 120);
  const categoryId = submission.categoryId || Number(details.categoryId) || null;
  let folderId = '';
  if (canWriteDrive()) {
    try { folderId = await createDriveFolder(name, await getDriveRootFolderId()); }
    catch (error) { console.error(`Не удалось создать папку Drive для клуба: ${error.message}`); }
  }
  const folderUrl = folderId ? `https://drive.google.com/drive/folders/${folderId}` : '';
  const stamp = nowIso();
  const result = db.prepare(`INSERT INTO clubs
    (name, category_id, short_description, full_description, telegram_channel_url, main_photo_url, recruitment_status, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Информация уточняется', 1, ?, ?)`)
    .run(name, categoryId, String(details.short || ''), String(details.description || details.short || ''),
      validHttpUrl(details.channel), folderUrl, stamp, stamp);
  const clubId = Number(result.lastInsertRowid);
  if (folderUrl) {
    db.prepare('INSERT INTO club_photos (club_id, photo_url, caption, is_cover, photo_order) VALUES (?, ?, ?, 1, 0)')
      .run(clubId, folderUrl, 'Папка с фотоматериалами и значком');
  }
  let uploaded = 0;
  // Стандарт имён в папке клуба: логотип — «Название(значок)», фото — «Название_1», «Название_2», ...
  const extOf = mime => ({
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/pjpeg': '.jpg',
    'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  }[String(mime || '').toLowerCase()] || '.jpg');
  let photoNumber = 0;
  const files = db.prepare('SELECT id, file_url, file_type, file_name, is_logo FROM request_files WHERE request_id=?').all(submission.id);
  for (const file of files) {
    if (!folderId || !DATA_URI_RE.test(String(file.file_url || ''))) continue;
    const targetName = Number(file.is_logo) === 1
      ? `${name}(значок)${extOf(file.file_type)}`
      : `${name}_${++photoNumber}${extOf(file.file_type)}`;
    try {
      const fileId = await uploadDriveFile(folderId, targetName, file.file_type || 'image/jpeg', file.file_url);
      db.prepare('UPDATE request_files SET file_url=? WHERE id=?').run(`https://lh3.googleusercontent.com/d/${fileId}=w1200`, file.id);
      uploaded++;
    } catch (error) {
      console.error(`Не удалось загрузить файл ${file.id} на Drive: ${error.message}`);
    }
  }
  db.prepare('UPDATE requests SET club_id=?, updated_at=? WHERE id=?').run(clubId, nowIso(), submission.id);
  db.prepare(`INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, details_json, at)
    VALUES (?, 'club_created_from_submission', 'club', ?, ?, ?)`)
    .run(adminDbId, clubId, JSON.stringify({ submissionId: submission.id, driveFolder: folderUrl, uploaded }), nowIso());
  return { clubId, clubName: name, driveFolder: folderUrl, uploadedFiles: uploaded };
}

function getCategories() {
  return db.prepare('SELECT id, name, description, icon FROM categories ORDER BY id').all().map(row => ({
    id: Number(row.id), name: row.name, description: row.description || '', icon: row.icon || ''
  }));
}
function getClubRow(id) {
  return db.prepare(`SELECT c.*, cat.name AS category_name, cat.icon AS category_icon
    FROM clubs c LEFT JOIN categories cat ON cat.id=c.category_id
    WHERE c.id=? AND c.is_active=1`).get(Number(id));
}
function clubPublic(rowOrId) {
  const row = typeof rowOrId === 'object' ? rowOrId : getClubRow(rowOrId);
  if (!row) return null;
  const photoRows = db.prepare('SELECT photo_url, caption, is_cover, photo_order FROM club_photos WHERE club_id=? ORDER BY is_cover DESC, photo_order, id').all(row.id);
  const links = [...new Set([row.main_photo_url, ...photoRows.map(x => x.photo_url)].filter(Boolean))];
  const images = links.filter(isDirectImageUrl);
  const contact = row.chairperson_contact || '';
  const tgHandleMatch = String(contact).match(/(?:https?:\/\/t\.me\/|@)([A-Za-z0-9_]{4,})/i);
  let schedule = safeJsonParse(row.schedule, null);
  if (!Array.isArray(schedule)) schedule = [];
  return {
    id: Number(row.id),
    name: row.name || '',
    categoryId: row.category_id == null ? null : Number(row.category_id),
    categoryName: row.category_name || '',
    categoryIcon: row.category_icon || '',
    short: row.short_description || '',
    description: row.full_description || row.short_description || '',
    fullDescription: row.full_description || '',
    history
  }
}