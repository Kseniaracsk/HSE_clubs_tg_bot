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
seedLink.run('hse_telegram', 'Telegram-канал Вышки', 'https://t.me/hse_nn', 20, seedStamp, seedStamp);
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
    history: row.history || '',
    directions: row.directions || '',
    targetAudience: row.target_audience || '',
    experienceRequired: row.experience_required || '',
    howToJoin: splitTextList(row.how_to_join),
    howToJoinText: row.how_to_join || '',
    schedule,
    scheduleText: row.schedule || '',
    recruitmentStatus: row.recruitment_status || '',
    chairman: {
      name: row.chairperson_name || '',
      info: contact,
      tg: tgHandleMatch ? tgHandleMatch[1] : ''
    },
    chairpersonName: row.chairperson_name || '',
    chairpersonContact: contact,
    channel: row.telegram_channel_url || row.telegram_chat_url || row.vk_group_url || row.website_url || '',
    telegramChannelUrl: row.telegram_channel_url || '',
    telegramChatUrl: row.telegram_chat_url || '',
    vkGroupUrl: row.vk_group_url || '',
    contacts: contact || row.telegram_chat_url || row.vk_group_url || '',
    formUrl: row.application_form_url || '',
    applicationFormUrl: row.application_form_url || '',
    websiteUrl: row.website_url || '',
    mainPhotoUrl: row.main_photo_url || '',
    images,
    photoResources: photoRows.map(x => ({ url: x.photo_url, caption: x.caption || 'Материалы клуба', isCover: Boolean(x.is_cover) })),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}
function getClubRows({ category, search, popular } = {}) {
  const where = ['c.is_active=1'];
  const args = [];
  if (popular) where.push('EXISTS (SELECT 1 FROM subscriptions sx WHERE sx.club_id=c.id AND sx.notifications_enabled=1)');
  if (category) { where.push('c.category_id=?'); args.push(Number(category)); }
  const order = popular
    ? 'subscription_count DESC, c.name COLLATE NOCASE'
    : 'c.name COLLATE NOCASE';
  const rows = db.prepare(`SELECT c.*, cat.name AS category_name, cat.icon AS category_icon,
      (SELECT COUNT(DISTINCT s.user_id) FROM subscriptions s WHERE s.club_id=c.id AND s.notifications_enabled=1) AS subscription_count
    FROM clubs c LEFT JOIN categories cat ON cat.id=c.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}`).all(...args);
  let clubs = rows.map(clubPublic).filter(Boolean);
  if (search) {
    // JS case-folding работает с кириллицей, в отличие от стандартного LOWER() в SQLite.
    const query = String(search).toLocaleLowerCase('ru-RU');
    clubs = clubs.filter(club => [club.name, club.short, club.description, club.directions]
      .some(value => String(value || '').toLocaleLowerCase('ru-RU').includes(query)));
  }
  return clubs;
}

function getUserRowByTelegramId(tgId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id=?').get(Number(tgId));
}
function getSubscriptionState(userPk) {
  const rows = db.prepare('SELECT club_id, category_id, notifications_enabled FROM subscriptions WHERE user_id=?').all(userPk);
  return {
    clubSubs: [...new Set(rows.filter(r => r.club_id != null).map(r => Number(r.club_id)))],
    categorySubs: [...new Set(rows.filter(r => r.category_id != null).map(r => Number(r.category_id)))],
    mutedClubs: [...new Set(rows.filter(r => r.club_id != null && !Number(r.notifications_enabled)).map(r => Number(r.club_id)))],
  };
}
function getOrCreateUser(tgUser) {
  const tgIdValue = Number(tgUser && tgUser.id);
  const tgId = Number.isSafeInteger(tgIdValue) && tgIdValue >= 0 ? tgIdValue : 0;
  const username = String(tgUser && tgUser.username || '').trim().replace(/^@/, '') || null;
  const firstName = String(tgUser && tgUser.first_name || '').trim() || (tgId ? 'Пользователь Telegram' : 'Локальный тестовый пользователь');
  const lastName = String(tgUser && tgUser.last_name || '').trim() || null;
  const photoUrl = String(tgUser && tgUser.photo_url || '').trim() || null;
  const languageCode = String(tgUser && tgUser.language_code || '').trim() || null;
  const isPremium = tgUser && tgUser.is_premium ? 1 : 0;
  const allowsWriteToPm = tgUser && tgUser.allows_write_to_pm ? 1 : 0;
  let row = getUserRowByTelegramId(tgId);
  const stamp = nowIso();
  if (!row) {
    db.prepare(`INSERT INTO users
      (telegram_id, chat_id, username, first_name, last_name, role, notifications_enabled, is_active, created_at, last_active_at,
       photo_url, language_code, is_premium, allows_write_to_pm, updated_at)
      VALUES (?, ?, ?, ?, ?, 'student', 1, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tgId, tgId, username, firstName, lastName, stamp, stamp, photoUrl, languageCode, isPremium, allowsWriteToPm, stamp);
    row = getUserRowByTelegramId(tgId);
  } else {
    db.prepare(`UPDATE users SET username=?, first_name=?, last_name=?, photo_url=COALESCE(?, photo_url),
      language_code=COALESCE(?, language_code), is_premium=?, allows_write_to_pm=?, is_active=1, updated_at=? WHERE id=?`)
      .run(username, firstName, lastName, photoUrl, languageCode, isPremium, allowsWriteToPm, stamp, row.id);
    row = db.prepare('SELECT * FROM users WHERE id=?').get(row.id);
  }
  const membership = db.prepare('SELECT id, role FROM admin_accounts WHERE user_id=? AND revoked_at IS NULL').get(row.id);
  const roleAdmin = ['admin', 'administrator'].includes(String(row.role || '').toLowerCase());
  const isAdmin = Boolean(roleAdmin && membership && String(membership.role).toLowerCase() === 'admin');
  const subs = getSubscriptionState(row.id);
  return {
    dbId: Number(row.id),
    tgId: Number(row.telegram_id),
    chatId: Number(row.chat_id),
    firstName: row.first_name || 'Пользователь Telegram',
    lastName: row.last_name || '',
    username: row.username || '',
    displayName: row.username ? '@' + row.username : [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Пользователь Telegram',
    photoUrl: row.photo_url || '',
    languageCode: row.language_code || '',
    isPremium: Boolean(row.is_premium),
    allowsWriteToPm: Boolean(row.allows_write_to_pm),
    isAdmin,
    role: isAdmin ? 'admin' : 'student',
    notificationsEnabled: Boolean(row.notifications_enabled),
    allNotificationsOff: !Boolean(row.notifications_enabled),
    clubSubs: subs.clubSubs,
    categorySubs: subs.categorySubs,
    mutedClubs: subs.mutedClubs,
    createdAt: row.created_at || null,
    lastActiveAt: row.last_active_at || null,
  };
}

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const userRaw = params.get('user');
  let user = null;
  try { user = userRaw ? JSON.parse(userRaw) : null; } catch (_) {}
  return { hash: params.get('hash') || '', user, params };
}
function validateInitData(initData) {
  // Для локального запуска без токена разрешаем тестирование; на production это запрещено.
  if (!BOT_TOKEN) return { ok: process.env.NODE_ENV !== 'production', dev: true };
  if (!initData) return { ok: false, reason: 'нет initData' };
  const { hash, params } = parseInitData(initData);
  if (!hash) return { ok: false, reason: 'нет hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const computedBuffer = Buffer.from(computed);
  const hashBuffer = Buffer.from(hash);
  const signatureOk = computedBuffer.length === hashBuffer.length && crypto.timingSafeEqual(computedBuffer, hashBuffer);
  if (!signatureOk) return { ok: false, reason: 'неверная подпись initData' };
  const authDate = Number(params.get('auth_date'));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || authDate > nowSeconds + 60 || nowSeconds - authDate > 24 * 60 * 60) {
    return { ok: false, reason: 'срок действия авторизации Telegram истёк' };
  }
  return { ok: true };
}

async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) throw new Error('Не задан TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || 'Ошибка Telegram');
  return result;
}

function normalizeStatus(status) {
  const s = String(status || 'pending').trim().toLowerCase();
  const map = {
    'на модерации': 'pending', 'ожидает модерации': 'pending', 'черновик': 'draft',
    'одобрено': 'approved', 'одобрена': 'approved', 'согласовано': 'approved',
    'доработать': 'changes', 'нужны доработки': 'changes', 'доработка': 'changes',
    'отклонено': 'rejected', 'отклонена': 'rejected', 'опубликовано': 'published',
    'опубликована': 'published', 'отменено': 'cancelled', 'отменена': 'cancelled'
  };
  return map[s] || s;
}
function getRequestMediaJson(requestId, fallback) {
  const files = db.prepare('SELECT file_url, file_type, file_name FROM request_files WHERE request_id=? ORDER BY id').all(Number(requestId));
  if (files.length) return JSON.stringify(files.filter(file => file.file_url).map(file => ({
    name: file.file_name || 'Вложение', type: file.file_type || 'application/octet-stream', data: file.file_url, url: file.file_url
  })));
  return fallback || '';
}
function saveRequestFiles(requestId, mediaValue) {
  const items = safeJsonParse(mediaValue, []);
  if (!Array.isArray(items)) return;
  const insert = db.prepare('INSERT INTO request_files (request_id, file_url, file_type, file_name) VALUES (?, ?, ?, ?)');
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const value = item.data || item.url || item.file_url || '';
    if (!value) continue;
    insert.run(Number(requestId), String(value), String(item.type || item.file_type || ''), String(item.name || item.file_name || 'Вложение'));
  }
}
function submissionPublic(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.telegram_id),
    userName: row.first_name || 'Студент',
    username: row.username || '',
    type: row.request_type || 'event',
    title: row.title || '',
    details: row.description || '',
    media: getRequestMediaJson(row.id, row.media_json),
    status: normalizeStatus(row.status),
    adminComment: row.moderator_comment || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    reviewedAt: row.reviewed_at || null,
    publishedAt: row.published_at || null,
    clubId: row.club_id == null ? null : Number(row.club_id),
    categoryId: row.category_id == null ? null : Number(row.category_id),
  };
}
const submissionSelect = `SELECT r.*, u.id AS user_db_id, u.telegram_id, u.first_name, u.username
  FROM requests r JOIN users u ON u.id=r.user_id`;
function getSubmissionById(id) {
  const row = db.prepare(`${submissionSelect} WHERE r.id=?`).get(Number(id));
  return submissionPublic(row);
}
function getAllSubmissions() {
  return db.prepare(`${submissionSelect} ORDER BY datetime(r.created_at) DESC, r.id DESC`).all().map(submissionPublic);
}
function isBroadcastEligibleSubmission(submission) {
  return Boolean(submission) && ['event', 'fix'].includes(String(submission.type || '').toLowerCase());
}

function addNotification(submission, kind = 'status') {
  const owner = getUserRowByTelegramId(submission.userId);
  if (!owner) return null;
  const statusNames = {
    pending: 'заявка отправлена на модерацию', approved: 'заявка одобрена',
    changes: 'по заявке нужны доработки', rejected: 'заявка отклонена',
    published: 'заявка опубликована', draft: 'заявка сохранена как черновик', cancelled: 'заявка отменена'
  };
  let message = kind === 'comment'
    ? `Комментарий администратора к заявке №${submission.id}.`
    : `Статус вашей заявки «${submission.title}»: ${statusNames[submission.status] || submission.status}.`;
  if (String(submission.adminComment || '').trim()) message += `\n\nКомментарий администратора: ${String(submission.adminComment).trim()}`;
  if (submission.status === 'approved' && isBroadcastEligibleSubmission(submission)) {
    message += '\n\nЗаявка одобрена и может быть добавлена администратором в рассылку.';
  } else if (submission.status === 'approved') {
    message += '\n\nЗаявка одобрена и будет обработана отдельно, без массовой рассылки.';
  }
  const stamp = nowIso();
  const result = db.prepare(`INSERT INTO app_notifications
    (user_id, request_id, club, text, time, at, read, type, status, telegram_sent)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'submission-status', ?, 0)`)
    .run(owner.id, submission.id, `Заявка №${submission.id}`, message,
      new Date().toLocaleString('ru-RU'), stamp, submission.status);
  const notification = {
    id: Number(result.lastInsertRowid), userId: Number(owner.telegram_id), club: `Заявка №${submission.id}`,
    text: message, time: new Date().toLocaleString('ru-RU'), at: stamp, read: false,
    type: 'submission-status', submissionId: submission.id, status: submission.status, telegramSent: false
  };
  if (BOT_TOKEN && Number(owner.telegram_id) > 0 && Number(owner.chat_id) > 0) {
    return sendTelegramMessage(owner.chat_id, message).then(() => {
      db.prepare('UPDATE app_notifications SET telegram_sent=1 WHERE id=?').run(notification.id);
      notification.telegramSent = true;
      return notification;
    }).catch(error => {
      db.prepare('UPDATE app_notifications SET telegram_error=? WHERE id=?').run(error.message, notification.id);
      console.error('Не удалось отправить уведомление Telegram:', error.message);
      return notification;
    });
  }
  return Promise.resolve(notification);
}

function getAudience(target, data = {}) {
  const activeUsers = db.prepare(`SELECT * FROM users WHERE is_active=1 AND notifications_enabled=1 AND telegram_id<>0 ORDER BY id`).all();
  const clubIds = (data.clubIds || []).map(Number).filter(Boolean);
  const clubId = Number(data.clubId) || 0;
  const categoryId = Number(data.categoryId) || 0;
  const categoryClubIds = categoryId
    ? db.prepare('SELECT id FROM clubs WHERE category_id=? AND is_active=1').all(categoryId).map(r => Number(r.id))
    : [];
  return activeUsers.filter(user => {
    const state = getSubscriptionState(user.id);
    if (target === 'club') return state.clubSubs.includes(clubId) && !state.mutedClubs.includes(clubId);
    if (target === 'clubs') return clubIds.some(id => state.clubSubs.includes(id) && !state.mutedClubs.includes(id));
    if (target === 'category') return state.categorySubs.includes(categoryId) || categoryClubIds.some(id => state.clubSubs.includes(id) && !state.mutedClubs.includes(id));
    return true;
  });
}
function broadcastPublic(row) {
  const recipientRows = db.prepare(`SELECT br.status, br.sent_at, br.user_id, u.telegram_id
    FROM broadcast_recipients br JOIN users u ON u.id=br.user_id WHERE br.broadcast_id=?`).all(row.id);
  const recipients = recipientRows.map(x => Number(x.telegram_id));
  const sentResults = recipientRows.filter(x => x.status === 'Отправлено');
  const failedResults = recipientRows.filter(x => String(x.status || '').startsWith('Ошибка'));
  const statusMap = { 'В очереди': 'queued', 'Отправляется': 'sending', 'Отправлена': 'done', 'Частично отправлена': 'done', 'Ошибка': 'done', 'Черновик': 'queued' };
  return {
    id: Number(row.id), target: row.audience_type || 'all', clubId: row.club_id == null ? null : Number(row.club_id),
    clubIds: safeJsonParse(row.club_ids_json, []), categoryId: row.category_id == null ? null : Number(row.category_id),
    text: row.message_text || '', submissionId: row.request_id == null ? null : Number(row.request_id),
    sendAt: row.scheduled_at || row.created_at, createdAt: row.created_at, sentAt: row.sent_at,
    status: statusMap[row.status] || row.status || 'queued', recipients, results: recipientRows.map(x => ({
      userId: Number(x.telegram_id), status: x.status === 'Отправлено' ? 'sent' : String(x.status || '').startsWith('Ошибка') ? 'failed' : 'queued',
      sentAt: x.sent_at || null, error: String(x.status || '').startsWith('Ошибка') ? String(x.status).replace(/^Ошибка:?\s*/, '') : undefined
    })), sent: sentResults.length, failed: failedResults.length
  };
}
function addPublishedEventFromSubmission(submission) {
  if (!submission || String(submission.type) !== 'event') return;
  const data = safeJsonParse(submission.details, {});
  const date = String(data.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  let clubId = Number(submission.clubId || data.clubId) || null;
  if (clubId && !getClubRow(clubId)) clubId = null;
  if (!clubId && data.clubName) {
    const match = db.prepare('SELECT id FROM clubs WHERE is_active=1 AND LOWER(name)=LOWER(?)').get(String(data.clubName).trim());
    if (match) clubId = Number(match.id);
  }
  // События в исходной схеме обязаны ссылаться на реальный клуб. Не создаём вымышленные клубы.
  if (!clubId) return;
  const exists = db.prepare('SELECT id FROM events WHERE source_post_url=? AND source_post_url IS NOT NULL').get(`request:${submission.id}`);
  if (exists) return;
  const imageUrl = safeJsonParse(submission.media, []).find(item => item && isDirectImageUrl(item.data || item.url));
  db.prepare(`INSERT INTO events
    (club_id, title, description, event_date, event_time, location, format, registration_url, image_url, source_post_url, status, event_type, organizer_contact)
    VALUES (?, ?, ?, ?, ?, ?, 'Офлайн', ?, ?, ?, 'Опубликовано', 'Мероприятие', ?)`)
    .run(clubId, data.title || submission.title, data.description || data.announcement || submission.details,
      date, data.time || null, data.place || null, data.registration || null,
      imageUrl ? (imageUrl.data || imageUrl.url) : null, `request:${submission.id}`, data.contact || null);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

app.use('/api', (req, res, next) => {
  const initData = req.get('x-init-data') || '';
  const check = validateInitData(initData);
  if (!check.ok) return res.status(401).json({ error: 'Не удалось проверить авторизацию Telegram. Откройте приложение через бота.' });
  const parsed = parseInitData(initData);
  const telegramId = Number(parsed.user && parsed.user.id);
  if (process.env.NODE_ENV === 'production' && (!Number.isSafeInteger(telegramId) || telegramId <= 0)) {
    return res.status(401).json({ error: 'Telegram не передал подтверждённый профиль. Откройте Mini App кнопкой внутри бота.' });
  }
  req.user = getOrCreateUser(parsed.user);
  const stamp = nowIso();
  const last = req.user.lastActiveAt ? new Date(req.user.lastActiveAt).getTime() : 0;
  const mutation = req.method !== 'GET';
  if (mutation || !Number.isFinite(last) || Date.now() - last > 60_000) {
    const pathname = req.path || '';
    const kind = /\/subscriptions/.test(pathname) && mutation ? 'subscription'
      : /\/submissions/.test(pathname) && mutation ? 'submission' : 'visit';
    db.prepare('UPDATE users SET last_active_at=? WHERE id=?').run(stamp, req.user.dbId);
    db.prepare('INSERT INTO user_activity(user_id, at, kind) VALUES (?, ?, ?)').run(req.user.dbId, stamp, kind);
    req.user.lastActiveAt = stamp;
  }
  next();
});

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Нет доступа администратора' });
  next();
}

// Вход и профиль. Личность пользователя определяется по Telegram ID из подписанного initData,
// а username (@ник) сохраняется как отображаемый контакт, но не используется как уникальный ключ.
app.post('/api/auth', (req, res) => res.json({ ok: true, user: {
  id: req.user.tgId, name: req.user.firstName, lastName: req.user.lastName,
  username: req.user.username, displayName: req.user.displayName, photoUrl: req.user.photoUrl,
  isAdmin: Boolean(req.user.isAdmin), role: req.user.isAdmin ? 'admin' : 'user'
} }));
app.get('/api/me', (req, res) => res.json({
  id: req.user.tgId, telegramId: req.user.tgId, name: req.user.firstName, lastName: req.user.lastName,
  username: req.user.username, displayName: req.user.displayName, photoUrl: req.user.photoUrl,
  isAdmin: Boolean(req.user.isAdmin), role: req.user.isAdmin ? 'admin' : 'user',
  languageCode: req.user.languageCode, isPremium: req.user.isPremium,
  createdAt: req.user.createdAt, lastActiveAt: req.user.lastActiveAt
}));
app.post('/api/admin/access', (req, res) => {
  if (req.user.isAdmin) return res.json({ ok: true, isAdmin: true, role: 'admin', message: 'У вас уже есть права администратора' });
  if (!ADMIN_ACCESS_CODE) return res.status(503).json({ error: 'Код администратора не настроен. Установите ADMIN_ACCESS_CODE в переменных окружения сервера.' });
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const recentFailures = Number(db.prepare(`SELECT COUNT(*) AS n FROM admin_access_attempts
    WHERE user_id=? AND success=0 AND attempted_at>=?`).get(req.user.dbId, cutoff).n);
  if (recentFailures >= 5) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 15 минут.' });
  }
  const actual = Buffer.from(String((req.body || {}).code || ''));
  const expected = Buffer.from(ADMIN_ACCESS_CODE);
  const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  const stamp = nowIso();
  db.prepare('INSERT INTO admin_access_attempts (user_id, attempted_at, success, failure_reason) VALUES (?, ?, ?, ?)')
    .run(req.user.dbId, stamp, valid ? 1 : 0, valid ? null : 'invalid_code');
  if (!valid) {
    db.prepare(`INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, details_json, at)
      VALUES (?, 'admin_login_failed', 'user', ?, ?, ?)`).run(req.user.dbId, req.user.dbId, JSON.stringify({ reason: 'invalid_code' }), stamp);
    return res.status(403).json({ error: 'Неверный код администратора' });
  }
  db.prepare("UPDATE users SET role='admin', updated_at=? WHERE id=?").run(stamp, req.user.dbId);
  db.prepare(`INSERT INTO admin_accounts (user_id, role, granted_by, granted_at, revoked_at, note)
    VALUES (?, 'admin', NULL, ?, NULL, 'Granted with environment-provided access code')
    ON CONFLICT(user_id) DO UPDATE SET role='admin', granted_by=NULL, granted_at=excluded.granted_at, revoked_at=NULL, note=excluded.note`)
    .run(req.user.dbId, stamp);
  db.prepare(`INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, details_json, at)
    VALUES (?, 'admin_role_granted', 'user', ?, ?, ?)`).run(req.user.dbId, req.user.dbId, JSON.stringify({ via: 'environment_code' }), stamp);
  req.user.isAdmin = true;
  req.user.role = 'admin';
  res.json({ ok: true, isAdmin: true, role: 'admin' });
});

function getPublicAppInfo() {
  const settingsRows = db.prepare('SELECT key, value FROM app_settings WHERE is_public=1 ORDER BY key').all();
  const settings = Object.fromEntries(settingsRows.map(row => [row.key, row.value]));
  const siteLinks = db.prepare(`SELECT link_key AS key, label, url, section, sort_order AS sortOrder
    FROM site_links WHERE is_active=1 ORDER BY sort_order, id`).all();
  const adminContacts = db.prepare(`SELECT name, role_title AS roleTitle, telegram_username AS telegramUsername,
    telegram_url AS telegramUrl, email, phone, is_primary AS isPrimary
    FROM admin_contacts WHERE is_active=1 AND visible_public=1 ORDER BY is_primary DESC, sort_order, id`).all();
  return { settings, siteLinks, adminContacts };
}
app.get('/api/app-info', (req, res) => res.json(getPublicAppInfo()));

// Категории из SQLite
app.get('/api/categories', (req, res) => res.json(getCategories()));
app.post('/api/categories/:id/subscribe', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM categories WHERE id=?').get(id)) return res.status(404).json({ error: 'Категория не найдена' });
  const existing = db.prepare('SELECT id FROM subscriptions WHERE user_id=? AND category_id=?').all(req.user.dbId, id);
  if (existing.length) db.prepare('DELETE FROM subscriptions WHERE user_id=? AND category_id=?').run(req.user.dbId, id);
  else db.prepare('INSERT INTO subscriptions (user_id, category_id, notifications_enabled) VALUES (?, ?, 1)').run(req.user.dbId, id);
  res.json({ categorySubs: getSubscriptionState(req.user.dbId).categorySubs });
});

// Клубы читаются только из hse_nn_clubs.db. Никаких искусственных карточек из JSON.
app.get('/api/clubs', (req, res) => {
  res.json(getClubRows({ category: req.query.category, search: req.query.search, popular: req.query.popular === '1' }));
});
app.get('/api/clubs/:id', (req, res) => {
  const club = clubPublic(Number(req.params.id));
  if (!club) return res.status(404).json({ error: 'Клуб не найден или не активен' });
  res.json(club);
});

// Подписки пользователей
app.get('/api/subscriptions', (req, res) => {
  const state = getSubscriptionState(req.user.dbId);
  const clubs = state.clubSubs.map(id => clubPublic(id)).filter(Boolean);
  res.json({ clubs, categorySubs: state.categorySubs, mutedClubs: state.mutedClubs, allNotificationsOff: req.user.allNotificationsOff });
});
app.post('/api/subscriptions/:clubId/toggle', (req, res) => {
  const id = Number(req.params.clubId);
  if (!getClubRow(id)) return res.status(404).json({ error: 'Клуб не найден' });
  const existing = db.prepare('SELECT id FROM subscriptions WHERE user_id=? AND club_id=?').all(req.user.dbId, id);
  if (existing.length) db.prepare('DELETE FROM subscriptions WHERE user_id=? AND club_id=?').run(req.user.dbId, id);
  else db.prepare('INSERT INTO subscriptions (user_id, club_id, notifications_enabled) VALUES (?, ?, 1)').run(req.user.dbId, id);
  const subscribed = getSubscriptionState(req.user.dbId).clubSubs.includes(id);
  res.json({ subscribed });
});
app.post('/api/subscriptions/:clubId/notifications', (req, res) => {
  const id = Number(req.params.clubId);
  if (!getClubRow(id)) return res.status(404).json({ error: 'Клуб не найден' });
  const enable = Boolean(req.body && req.body.enabled);
  const rows = db.prepare('SELECT id FROM subscriptions WHERE user_id=? AND club_id=?').all(req.user.dbId, id);
  if (rows.length) db.prepare('UPDATE subscriptions SET notifications_enabled=? WHERE user_id=? AND club_id=?').run(enable ? 1 : 0, req.user.dbId, id);
  else if (enable) db.prepare('INSERT INTO subscriptions (user_id, club_id, notifications_enabled) VALUES (?, ?, 1)').run(req.user.dbId, id);
  res.json({ enabled: enable });
});
app.post('/api/notifications/disable-all', (req, res) => {
  db.prepare('UPDATE users SET notifications_enabled=0 WHERE id=?').run(req.user.dbId);
  res.json({ ok: true });
});
app.get('/api/notifications/history', (req, res) => {
  const rows = db.prepare(`SELECT n.*, u.telegram_id FROM app_notifications n
    JOIN users u ON u.id=n.user_id WHERE n.user_id=? ORDER BY datetime(n.at) DESC, n.id DESC`).all(req.user.dbId);
  res.json(rows.map(n => ({
    id: Number(n.id), userId: Number(n.telegram_id), club: n.club || '', text: n.text,
    time: n.time || '', at: n.at, read: Boolean(n.read), type: n.type,
    submissionId: n.request_id == null ? null : Number(n.request_id), status: n.status,
    telegramSent: Boolean(n.telegram_sent), telegramError: n.telegram_error || ''
  })));
});

// События только из таблицы events. Если таблица пуста, интерфейс честно покажет пустой список.
function eventPublic(row) {
  if (!row) return null;
  const club = clubPublic(Number(row.club_id));
  const date = String(row.event_date || '').slice(0, 10);
  const time = String(row.event_time || '').slice(0, 8);
  const datetime = date ? `${date}T${time || '00:00:00'}` : '';
  const image = isImageSource(row.image_url) ? row.image_url : '';
  return {
    id: Number(row.id), clubId: Number(row.club_id), title: row.title || '',
    description: row.description || '', datetime, date, time,
    type: row.event_type || 'Мероприятие', format: row.format || '',
    place: row.location || '', registrationUrl: row.registration_url || '',
    image, images: image ? [image] : [], sourcePostUrl: row.source_post_url || '',
    organizerContact: row.organizer_contact || '', status: row.status || '', club
  };
}
app.get('/api/events/:id', (req, res) => {
  const row = db.prepare("SELECT e.* FROM events e JOIN clubs c ON c.id=e.club_id WHERE e.id=? AND c.is_active=1 AND LOWER(COALESCE(e.status,'Опубликовано')) IN ('опубликовано','published','approved')").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Событие не найдено' });
  res.json(eventPublic(row));
});
app.get('/api/events', (req, res) => {
  const filter = String(req.query.filter || 'today');
  let rows;
  if (filter === 'today') {
    rows = db.prepare("SELECT e.* FROM events e JOIN clubs c ON c.id=e.club_id WHERE c.is_active=1 AND LOWER(COALESCE(e.status,'Опубликовано')) IN ('опубликовано','published','approved') AND substr(e.event_date,1,10)=date('now','localtime') ORDER BY e.event_date,e.event_time,e.id").all();
  } else if (filter === 'my') {
    rows = db.prepare("SELECT e.* FROM events e JOIN clubs c ON c.id=e.club_id WHERE c.is_active=1 AND LOWER(COALESCE(e.status,'Опубликовано')) IN ('опубликовано','published','approved') AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id=? AND s.club_id=e.club_id) ORDER BY e.event_date,e.event_time,e.id").all(req.user.dbId);
  } else {
    rows = db.prepare("SELECT e.* FROM events e JOIN clubs c ON c.id=e.club_id WHERE c.is_active=1 AND LOWER(COALESCE(e.status,'Опубликовано')) IN ('опубликовано','published','approved') ORDER BY e.event_date,e.event_time,e.id").all();
  }
  res.json(rows.map(eventPublic));
});

// Заявки студентов сохраняются в requests, пользовательские вложения — в media_json.
app.post('/api/submissions', (req, res) => {
  const { type = 'event', title = '', details = '', media = '', draft = false } = req.body || {};
  if (!String(title).trim()) return res.status(400).json({ error: 'Укажите название' });
  const parsedDetails = safeJsonParse(details, {});
  const clubId = Number(parsedDetails.clubId) || null;
  const categoryId = Number(parsedDetails.categoryId) || null;
  if (clubId && !db.prepare('SELECT id FROM clubs WHERE id=? AND is_active=1').get(clubId)) return res.status(400).json({ error: 'Выбранный клуб не найден' });
  if (categoryId && !db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) return res.status(400).json({ error: 'Выбранная категория не найдена' });
  const stamp = nowIso();
  const result = db.prepare(`INSERT INTO requests
    (user_id, club_id, category_id, request_type, title, description, media_json, status, moderator_comment, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`)
    .run(req.user.dbId, clubId, categoryId, String(type), String(title).trim(), String(details || ''), '', draft ? 'draft' : 'pending', stamp, stamp);
  saveRequestFiles(Number(result.lastInsertRowid), media);
  db.prepare(`INSERT INTO request_status_history (request_id, actor_user_id, previous_status, next_status, comment, at)
    VALUES (?, ?, NULL, ?, '', ?)`).run(Number(result.lastInsertRowid), req.user.dbId, draft ? 'draft' : 'pending', stamp);
  res.json({ ok: true, submission: getSubmissionById(Number(result.lastInsertRowid)) });
});
app.get('/api/submissions/my', (req, res) => {
  res.json(db.prepare(`${submissionSelect} WHERE r.user_id=? ORDER BY datetime(r.created_at) DESC,r.id DESC`).all(req.user.dbId).map(submissionPublic));
});
app.post('/api/submissions/:id/cancel', (req, res) => {
  const sub = db.prepare(`${submissionSelect} WHERE r.id=? AND r.user_id=?`).get(Number(req.params.id), req.user.dbId);
  const submission = submissionPublic(sub);
  if (!submission) return res.status(404).json({ error: 'Заявка не найдена' });
  if (!['pending', 'changes', 'draft'].includes(submission.status)) return res.status(400).json({ error: 'Эту заявку уже нельзя отменить' });
  const stamp = nowIso();
  db.prepare("UPDATE requests SET status='cancelled', updated_at=? WHERE id=?").run(stamp, submission.id);
  db.prepare(`INSERT INTO request_status_history (request_id, actor_user_id, previous_status, next_status, comment, at)
    VALUES (?, ?, ?, 'cancelled', '', ?)`).run(submission.id, req.user.dbId, submission.status, stamp);
  res.json({ ok: true });
});
app.put('/api/submissions/:id', (req, res) => {
  const submission = submissionPublic(db.prepare(`${submissionSelect} WHERE r.id=? AND r.user_id=?`).get(Number(req.params.id), req.user.dbId));
  if (!submission) return res.status(404).json({ error: 'Заявка не найдена' });
  if (!['pending', 'changes', 'draft'].includes(submission.status)) return res.status(400).json({ error: 'Заявку нельзя редактировать' });
  const { title, details, media, draft } = req.body || {};
  if (!String(title || '').trim()) return res.status(400).json({ error: 'Укажите название' });
  const parsedDetails = safeJsonParse(details, {});
  const previousStatus = submission.status;
  const updatedAt = nowIso();
  const nextStatus = draft ? 'draft' : 'pending';
  db.prepare(`UPDATE requests SET title=?, description=?, media_json='', status=?, club_id=?, category_id=?, updated_at=? WHERE id=?`)
    .run(String(title).trim(), String(details || ''), nextStatus,
      Number(parsedDetails.clubId) || null, Number(parsedDetails.categoryId) || null, updatedAt, submission.id);
  db.prepare(`INSERT INTO request_status_history (request_id, actor_user_id, previous_status, next_status, comment, at)
    VALUES (?, ?, ?, ?, 'Автор обновил заявку', ?)`).run(submission.id, req.user.dbId, previousStatus, nextStatus, updatedAt);
  db.prepare('DELETE FROM request_files WHERE request_id=?').run(submission.id);
  saveRequestFiles(submission.id, media);
  res.json({ ok: true, submission: getSubmissionById(submission.id) });
});

// Административная аналитика и модерация
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const submissions = getAllSubmissions();
  const userRows = db.prepare('SELECT * FROM users').all();
  const activeRows = userRows.filter(u => Number(u.telegram_id) !== 0);
  const activityLog = db.prepare(`SELECT a.*,u.telegram_id FROM user_activity a JOIN users u ON u.id=a.user_id WHERE datetime(a.at)>=datetime('now','-30 days') ORDER BY a.at`).all();
  const now = new Date();
  const activityByDay = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (29 - index));
    const date = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
    const rows = activityLog.filter(row => String(row.at || '').slice(0,10) === date);
    return {
      date,
      users: new Set(rows.filter(r => Number(r.telegram_id) !== 0).map(r => Number(r.telegram_id))).size,
      subscriptions: rows.filter(r => r.kind === 'subscription').length,
      submissions: rows.filter(r => r.kind === 'submission').length,
    };
  });
  const clubs = getClubRows();
  const categories = getCategories();
  const events = db.prepare("SELECT e.* FROM events e JOIN clubs c ON c.id=e.club_id WHERE c.is_active=1 AND LOWER(COALESCE(e.status,'Опубликовано')) IN ('опубликовано','published','approved') ORDER BY e.event_date,e.event_time").all().map(eventPublic);
  const activeUsers = new Set(activityLog.filter(r => Number(r.telegram_id) !== 0 && Date.now() - new Date(r.at).getTime() < 7 * 864e5).map(r => Number(r.telegram_id))).size;
  res.json({
    role: 'admin',
    activity: {
      users: activeRows.length,
      subscriptions: Number(db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE club_id IS NOT NULL').get().n),
      activeUsers, clubs: clubs.length, events: events.length
    },
    activityByDay, clubs, categories, events, submissions,
    pendingSubmissions: submissions.filter(s => ['pending', 'changes'].includes(s.status)),
    reach: activeRows.filter(u => Number(u.notifications_enabled) === 1).length
  });
});
app.post('/api/admin/clubs/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!getClubRow(id)) return res.status(404).json({ error: 'Клуб не найден' });
  const body = req.body || {};
  const fields = [];
  const args = [];
  if (body.name != null) {
    if (!String(body.name).trim()) return res.status(400).json({ error: 'Укажите название клуба' });
    fields.push('name=?'); args.push(String(body.name).trim());
  }
  if (body.short != null) { fields.push('short_description=?'); args.push(String(body.short).trim()); }
  if (body.description != null) { fields.push('full_description=?'); args.push(String(body.description).trim()); }
  if (body.categoryId != null) {
    const catId = Number(body.categoryId);
    if (!db.prepare('SELECT id FROM categories WHERE id=?').get(catId)) return res.status(400).json({ error: 'Категория не найдена' });
    fields.push('category_id=?'); args.push(catId);
  }
  if (body.channel != null) { fields.push('telegram_channel_url=?'); args.push(String(body.channel).trim()); }
  if (body.contacts != null) { fields.push('chairperson_contact=?'); args.push(String(body.contacts).trim()); }
  if (fields.length) {
    fields.push('updated_at=?'); args.push(nowIso()); args.push(id);
    try { db.prepare(`UPDATE clubs SET ${fields.join(', ')} WHERE id=?`).run(...args); }
    catch (error) { return res.status(400).json({ error: error.message.includes('UNIQUE') ? 'Клуб с таким названием уже существует' : 'Не удалось обновить клуб' }); }
  }
  res.json({ ok: true, club: clubPublic(id) });
});
app.post('/api/admin/submissions/:id/comment', requireAdmin, async (req, res) => {
  const submission = getSubmissionById(req.params.id);
  if (!submission) return res.status(404).json({ error: 'Заявка не найдена' });
  const comment = String((req.body || {}).comment || '').trim();
  const stamp = nowIso();
  db.prepare('UPDATE requests SET moderator_comment=?, updated_at=?, reviewed_at=?, reviewed_by=? WHERE id=?')
    .run(comment, stamp, stamp, req.user.dbId, submission.id);
  db.prepare(`INSERT INTO request_status_history (request_id, actor_user_id, previous_status, next_status, comment, at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(submission.id, req.user.dbId, submission.status, submission.status, comment, stamp);
  db.prepare(`INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, details_json, at)
    VALUES (?, 'request_comment_saved', 'request', ?, ?, ?)`).run(req.user.dbId, submission.id, JSON.stringify({ commentLength: comment.length }), stamp);
  await addNotification(getSubmissionById(submission.id), 'comment');
  res.json({ ok: true, submission: getSubmissionById(submission.id) });
});
app.post('/api/admin/submissions/:id/status', requireAdmin, async (req, res) => {
  const submission = getSubmissionById(req.params.id);
  if (!submission) return res.status(404).json({ error: 'Заявка не найдена' });
  const allowed = ['pending', 'approved', 'changes', 'rejected', 'published'];
  const status = normalizeStatus(req.body && req.body.status);
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Неверный статус' });
  const body = req.body || {};
  let clubId = submission.clubId;
  let categoryId = submission.categoryId;
  if (Object.prototype.hasOwnProperty.call(body, 'clubId')) clubId = Number(body.clubId) || null;
  if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) categoryId = Number(body.categoryId) || null;
  if (clubId && !getClubRow(clubId)) return res.status(400).json({ error: 'Клуб не найден' });
  if (categoryId && !db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) return res.status(400).json({ error: 'Категория не найдена' });
  const comment = Object.prototype.hasOwnProperty.call(body, 'comment') ? String(body.comment || '').trim() : submission.adminComment;
  const stamp = nowIso();
  db.prepare(`UPDATE requests SET status=?, moderator_comment=?, club_id=?, category_id=?, updated_at=?, reviewed_at=?, reviewed_by=?${status === 'published' ? ', published_at=?' : ''} WHERE id=?`)
    .run(...[status, comment, clubId, categoryId, stamp, stamp, req.user.dbId, ...(status === 'published' ? [stamp] : []), submission.id]);
  db.prepare(`INSERT INTO request_status_history (request_id, actor_user_id, previous_status, next_status, comment, at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(submission.id, req.user.dbId, submission.status, status, comment, stamp);
  db.prepare(`INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, details_json, at)
    VALUES (?, 'request_status_changed', 'request', ?, ?, ?)`).run(req.user.dbId, submission.id, JSON.stringify({ from: submission.status, to: status }), stamp);
  const updated = getSubmissionById(submission.id);
  if (submission.status !== status || comment !== submission.adminComment) await addNotification(updated, 'status');
  res.json({ ok: true, submission: updated });
});
app.post('/api/admin/submissions/:id/edit', requireAdmin, (req, res) => {
  const submission = getSubmissionById(req.params.id);
  if (!submission) return res.status(404).json({ error: 'Заявка не найдена' });
  const { title, details } = req.body || {};
  if (!String(title || '').trim()) return res.status(400).json({ error: 'Укажите название' });
  db.prepare('UPDATE requests SET title=?, description=?, updated_at=? WHERE id=?').run(String(title).trim(), String(details || ''), nowIso(), submission.id);
  res.json({ ok: true, submission: getSubmissionById(submission.id) });
});
// Администратор может редактировать ссылки проекта и контакты через панель;
// сами значения лежат в таблицах site_links/admin_contacts, а не в HTML-файлах.
app.get('/api/admin/content-settings', requireAdmin, (req, res) => {
  res.json({
    settings: db.prepare('SELECT key, value, is_public AS isPublic FROM app_settings ORDER BY key').all(),
    siteLinks: db.prepare('SELECT * FROM site_links ORDER BY sort_order, id').all().map(row => ({
      id: Number(row.id), key: row.link_key, label: row.label, url: row.url, section: row.section,
      sortOrder: Number(row.sort_order), isActive: Boolean(row.is_active)
    })),
    adminContacts: db.prepare('SELECT * FROM admin_contacts ORDER BY is_primary DESC, sort_order, id').all().map(row => ({
      id: Number(row.id), key: row.contact_key, name: row.name, roleTitle: row.role_title || '',
      telegramUsername: row.telegram_username || '', telegramUrl: row.telegram_url || '', email: row.email || '', phone: row.phone || '',
      visiblePublic: Boolean(row.visible_public), isPrimary: Boolean(row.is_primary), isActive: Boolean(row.is_active), sortOrder: Number(row.sort_order)
    }))
  });
});
function validHttpUrl(value) {
  try { const parsed = new URL(String(value || '').trim()); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''; }
  catch (_) { return ''; }
}
app.post('/api/admin/site-links', requireAdmin, (req, res) => {
  const body = req.body || {};
  const label = String(body.label || '').trim(); const url = validHttpUrl(body.url);
  if (!label || !url) return res.status(400).json({ error: 'Укажите название и корректную ссылку HTTP/HTTPS' });
  const key = `custom_${crypto.randomBytes(6).toString('hex')}`; const stamp = nowIso();
  const result = db.prepare(`INSERT INTO site_links (link_key,label,url,section,sort_order,is_active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(key,label,url,['profile','about','all'].includes(body.section) ? body.section : 'all',
      Number(body.sortOrder)||100, body.isActive === false ? 0 : 1, stamp, stamp);
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});
app.put('/api/admin/site-links/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id); const body = req.body || {};
  if (!db.prepare('SELECT id FROM site_links WHERE id=?').get(id)) return res.status(404).json({ error: 'Ссылка не найдена' });
  const label = String(body.label || '').trim(); const url = validHttpUrl(body.url);
  if (!label || !url) return res.status(400).json({ error: 'Укажите название и корректную ссылку HTTP/HTTPS' });
  db.prepare(`UPDATE site_links SET label=?,url=?,section=?,sort_order=?,is_active=?,updated_at=? WHERE id=?`)
    .run(label,url,['profile','about','all'].includes(body.section) ? body.section : 'all', Number(body.sortOrder)||100, body.isActive ? 1 : 0, nowIso(), id);
  res.json({ ok: true });
});
app.post('/api/admin/contacts', requireAdmin, (req, res) => {
  const body = req.body || {}; const name = String(body.name || '').trim();
  const tgUsername = String(body.telegramUsername || '').trim().replace(/^@/, '');
  const tgUrl = validHttpUrl(body.telegramUrl || (tgUsername ? `https://t.me/${tgUsername}` : ''));
  if (!name || (!tgUrl && !String(body.email || '').trim() && !String(body.phone || '').trim()))
    return res.status(400).json({ error: 'Укажите имя контакта и хотя бы один способ связи' });
  const key = `contact_${crypto.randomBytes(6).toString('hex')}`; const stamp = nowIso();
  const result = db.prepare(`INSERT INTO admin_contacts
    (contact_key,name,role_title,telegram_username,telegram_url,email,phone,visible_public,is_primary,is_active,sort_order,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?)`).run(key,name,String(body.roleTitle||''),tgUsername||null,tgUrl||null,
      String(body.email||'').trim()||null,String(body.phone||'').trim()||null,body.visiblePublic===false?0:1,body.isActive===false?0:1,
      Number(body.sortOrder)||100,stamp,stamp);
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});
app.put('/api/admin/contacts/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id); const body = req.body || {};
  if (!db.prepare('SELECT id FROM admin_contacts WHERE id=?').get(id)) return res.status(404).json({ error: 'Контакт не найден' });
  const name = String(body.name || '').trim();
  const tgUsername = String(body.telegramUsername || '').trim().replace(/^@/, '');
  const tgUrl = validHttpUrl(body.telegramUrl || (tgUsername ? `https://t.me/${tgUsername}` : ''));
  if (!name || (!tgUrl && !String(body.email||'').trim() && !String(body.phone||'').trim()))
    return res.status(400).json({ error: 'Укажите имя контакта и хотя бы один способ связи' });
  if (body.isPrimary) db.prepare('UPDATE admin_contacts SET is_primary=0 WHERE id<>?').run(id);
  db.prepare(`UPDATE admin_contacts SET name=?,role_title=?,telegram_username=?,telegram_url=?,email=?,phone=?,
    visible_public=?,is_active=?,is_primary=?,sort_order=?,updated_at=? WHERE id=?`)
    .run(name,String(body.roleTitle||''),tgUsername||null,tgUrl||null,String(body.email||'').trim()||null,
      String(body.phone||'').trim()||null,body.visiblePublic?1:0,body.isActive?1:0,body.isPrimary?1:0,
      Number(body.sortOrder)||100,nowIso(),id);
  res.json({ ok: true });
});

app.post('/api/admin/broadcast/preview', requireAdmin, (req, res) => {
  const body = req.body || {};
  res.json({ reached: getAudience(body.target || 'all', body).length });
});
app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const { target = 'all', title = '', clubId, clubIds, categoryId, sendAt, submissionId } = req.body || {};
  if (!String(title).trim()) return res.status(400).json({ error: 'Укажите текст рассылки' });
  let linkedSubmission = null;
  if (submissionId) {
    linkedSubmission = getSubmissionById(submissionId);
    if (!linkedSubmission) return res.status(404).json({ error: 'Заявка для рассылки не найдена' });
    if (linkedSubmission.status !== 'approved') return res.status(400).json({ error: 'В рассылку можно добавить только одобренную заявку' });
    if (!isBroadcastEligibleSubmission(linkedSubmission)) return res.status(400).json({ error: 'В массовую рассылку можно добавить только одобренный анонс события или изменение карточки клуба.' });
  }
  if (target === 'club' && !getClubRow(Number(clubId))) return res.status(400).json({ error: 'Выберите клуб для рассылки' });
  if (target === 'category' && !db.prepare('SELECT id FROM categories WHERE id=?').get(Number(categoryId))) return res.status(400).json({ error: 'Выберите категорию для рассылки' });
  const audience = getAudience(target, { clubId, clubIds, categoryId });
  const scheduledDate = sendAt ? new Date(sendAt) : new Date();
  if (!Number.isFinite(scheduledDate.getTime())) return res.status(400).json({ error: 'Неверное время отправки' });
  const scheduledAt = scheduledDate.toISOString();
  let broadcastId;
  try {
    db.exec('BEGIN');
    const inserted = db.prepare(`INSERT INTO broadcasts
      (request_id, title, message_text, audience_type, club_id, category_id, club_ids_json, status, scheduled_at, created_at, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'В очереди', ?, ?, ?, ?)`)
      .run(Number(submissionId) || null, String(title).trim(), String(title).trim(), target,
        Number(clubId) || null, Number(categoryId) || null, JSON.stringify((clubIds || []).map(Number)), scheduledAt, nowIso(), req.user.dbId, nowIso());
    broadcastId = Number(inserted.lastInsertRowid);
    const addRecipient = db.prepare('INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, user_id, status) VALUES (?, ?, ?)');
    for (const user of audience) addRecipient.run(broadcastId, Number(user.id), 'Ожидает отправки');
    db.exec('COMMIT');
    db.prepare(`INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, details_json, at)
      VALUES (?, 'broadcast_created', 'broadcast', ?, ?, ?)`).run(req.user.dbId, broadcastId,
        JSON.stringify({ target, recipientCount: audience.length, submissionId: Number(submissionId) || null }), nowIso());
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('Не удалось создать рассылку:', error.message);
    return res.status(500).json({ error: 'Не удалось создать рассылку' });
  }
  res.json({ ok: true, taskId: broadcastId, reached: audience.length, status: 'queued' });
});
app.get('/api/admin/broadcasts', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM broadcasts ORDER BY id').all();
  res.json(rows.map(broadcastPublic));
});

async function processBroadcastQueue() {
  const row = db.prepare(`SELECT * FROM broadcasts WHERE status='В очереди' AND (scheduled_at IS NULL OR datetime(scheduled_at)<=datetime('now')) ORDER BY id LIMIT 1`).get();
  if (!row) return;
  db.prepare("UPDATE broadcasts SET status='Отправляется' WHERE id=?").run(row.id);
  const recipients = db.prepare(`SELECT br.id AS recipient_id, br.user_id, u.chat_id, u.telegram_id
    FROM broadcast_recipients br JOIN users u ON u.id=br.user_id WHERE br.broadcast_id=? AND br.status='Ожидает отправки' ORDER BY br.id`).all(row.id);
  for (const recipient of recipients) {
    try {
      await sendTelegramMessage(recipient.chat_id, row.message_text || '');
      db.prepare("UPDATE broadcast_recipients SET status='Отправлено', sent_at=? WHERE id=?").run(nowIso(), recipient.recipient_id);
    } catch (error) {
      db.prepare('UPDATE broadcast_recipients SET status=?, sent_at=? WHERE id=?').run(`Ошибка: ${error.message}`, nowIso(), recipient.recipient_id);
    }
  }
  const stats = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN status='Отправлено' THEN 1 ELSE 0 END) AS sent,
    SUM(CASE WHEN status LIKE 'Ошибка%' THEN 1 ELSE 0 END) AS failed
    FROM broadcast_recipients WHERE broadcast_id=?`).get(row.id);
  const finalStatus = Number(stats.failed || 0) > 0 && Number(stats.sent || 0) > 0 ? 'Частично отправлена'
    : Number(stats.sent || 0) > 0 || Number(stats.total || 0) === 0 ? 'Отправлена' : 'Ошибка';
  const finished = nowIso();
  db.prepare('UPDATE broadcasts SET status=?, sent_at=? WHERE id=?').run(finalStatus, finished, row.id);
  if (Number(row.request_id) && Number(stats.sent || 0) > 0) {
    const submission = getSubmissionById(Number(row.request_id));
    if (submission && submission.status === 'approved' && isBroadcastEligibleSubmission(submission)) {
      if (submission.type === 'event') addPublishedEventFromSubmission(submission);
      db.prepare("UPDATE requests SET status='published', published_at=?, reviewed_at=?, updated_at=? WHERE id=?").run(finished, finished, finished, submission.id);
      db.prepare(`INSERT INTO request_status_history (request_id, actor_user_id, previous_status, next_status, comment, at)
        VALUES (?, NULL, 'approved', 'published', 'Опубликовано через рассылку', ?)`).run(submission.id, finished);
      db.prepare(`INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, details_json, at)
        VALUES (NULL, 'broadcast_finished', 'broadcast', ?, ?, ?)`).run(row.id, JSON.stringify({ sent: Number(stats.sent || 0), failed: Number(stats.failed || 0) }), finished);
      await addNotification(getSubmissionById(submission.id), 'status');
    }
  }
}

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' });
  res.status(404).send('404 — такая страница не найдена');
});

const queueTimer = setInterval(() => {
  processBroadcastQueue().catch(error => console.error('Ошибка обработки очереди рассылок:', error.message));
}, 3000);
if (typeof queueTimer.unref === 'function') queueTimer.unref();
app.listen(PORT, '0.0.0.0', () => {
  const counts = {
    categories: db.prepare('SELECT COUNT(*) AS n FROM categories').get().n,
    clubs: db.prepare('SELECT COUNT(*) AS n FROM clubs WHERE is_active=1').get().n,
    events: db.prepare("SELECT COUNT(*) AS n FROM events WHERE LOWER(COALESCE(status,'Опубликовано')) IN ('опубликовано','published','approved')").get().n,
  };
  console.log(`HSE clubs NN запущен на порту ${PORT}. SQLite: ${DB_FILE}`);
  console.log(`Данные из SQLite: ${counts.categories} категорий, ${counts.clubs} активных клубов, ${counts.events} опубликованных событий.`);
});
