'use strict';
const fs = require('fs');
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = 'http://localhost:3000';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
const api = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(d)}`);
  return d;
};
(async () => {
  await api('POST', '/api/auth');
  await api('POST', '/api/admin/access', { code: env.ADMIN_ACCESS_CODE });
  const cats = await api('GET', '/api/categories');
  const name = 'Клуб Тест Драйв ' + new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const details = JSON.stringify({ title: name, short: 'Тестовая заявка', description: 'Проверка создания папки Drive и переименования фото', channel: 'https://t.me/test' });
  const media = JSON.stringify([
    { name: 'logo.png', type: 'image/png', data: PNG, logo: true },
    { name: 'photo1.jpg', type: 'image/jpeg', data: JPG },
    { name: 'photo2.jpg', type: 'image/jpeg', data: JPG },
  ]);
  const sub = await api('POST', '/api/submissions', { type: 'club', title: name, details, media });
  console.log('Заявка создана: id=' + sub.submission.id);
  const res = await api('POST', `/api/admin/submissions/${sub.submission.id}/status`, { status: 'approved' });
  console.log('Одобрена. createdClub =', JSON.stringify(res.createdClub ? { clubId: res.createdClub.clubId, name: res.createdClub.clubName, folder: res.createdClub.driveFolder, uploaded: res.createdClub.uploadedFiles } : null));
  if (!res.createdClub) { console.log('createdClub отсутствует!'); return; }
  const folderId = res.createdClub.driveFolder.match(/folders\/([A-Za-z0-9_-]+)/)[1];
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const lr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&key=${env.GOOGLE_DRIVE_API_KEY}&fields=files(id,name,mimeType)&pageSize=50`);
  const ld = await lr.json();
  console.log('\nСодержимое папки (листинг по API-ключу):');
  for (const f of (ld.files || [])) console.log('  ' + f.name + (f.mimeType === 'application/vnd.google-apps.folder' ? ' [папка]' : ''));
  const img = (ld.files || []).find(f => f.name.includes('_1'));
  if (img) {
    const hr = await fetch(`https://lh3.googleusercontent.com/d/${img.id}=w1200`, { method: 'GET' });
    console.log(`\nПроверка lh3-ссылки ${img.name}: HTTP ${hr.status}, ${hr.headers.get('content-type')}`);
  }
  const club = await api('GET', `/api/clubs/${res.createdClub.clubId}`);
  console.log('\nКлуб в API: images=' + (club.images || []).length + ', mainPhotoUrl=' + club.mainPhotoUrl);
})().catch(e => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
