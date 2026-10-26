import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { ROOT, UPLOAD_DIR, get, seedAccounts } from './db.js';
import { api } from './api.js';
import { requireAuth } from './auth.js';
import { startJobs } from './jobs.js';

seedAccounts();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
// в Express 5 у запроса без тела req.body не определён — обработчикам проще всегда получать объект
app.use((req, res, next) => { req.body ??= {}; next(); });

app.use('/api', api);

// Видео и фото отдаются только вошедшим пользователям; sendFile поддерживает перемотку (Range)
app.get('/media/:id', requireAuth, (req, res) => {
  const m = get('SELECT * FROM media WHERE id = ?', req.params.id);
  if (!m || m.expired) return res.status(404).send('Файл удалён');
  if (m.owner_type === 'cleaning' && req.user.role !== 'chief') {
    const c = get('SELECT cleaner_id FROM cleanings WHERE id = ?', m.owner_id);
    if (c?.cleaner_id !== req.user.id) return res.status(403).send('Нет доступа');
  }
  res.type(m.mime || 'application/octet-stream');
  res.sendFile(path.join(UPLOAD_DIR, m.filename), { maxAge: '7d' });
});

const pub = path.join(ROOT, 'public');
// no-cache: браузер (особенно приложение с экрана «Домой» на iPhone) каждый раз сверяет файлы с сервером,
// иначе после обновления он может смешать старые и новые модули и показать пустой экран
app.use(express.static(pub, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(pub, 'index.html'));
});

const port = +process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`«Порядок» запущен: http://localhost:${port}`);
  startJobs();
});
