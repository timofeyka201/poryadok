import crypto from 'node:crypto';
import { get, run, checkPassword, withDb } from './db.js';
import { DEMO_LOGIN, DEMO_PASSWORD, createSandbox, getSandbox, destroySandbox } from './demo.js';

const COOKIE = 'sid';
const MAX_AGE = 1000 * 60 * 60 * 24 * 180; // полгода — чтобы уборщицам не приходилось часто входить

const attempts = new Map(); // ip -> { count, until }

export function login(req, res) {
  const ip = req.ip;
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) {
    return res.status(429).json({ error: 'Слишком много попыток. Подождите минуту.' });
  }
  const { login, password } = req.body || {};
  const name = String(login || '').trim().toLowerCase();
  if ((name === DEMO_LOGIN || name === 'демо') && [DEMO_PASSWORD, 'демо'].includes(String(password || '').trim().toLowerCase())) {
    const token = createSandbox();
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MAX_AGE });
    return res.json({ ok: true, demo: true });
  }
  const user = get('SELECT * FROM users WHERE login = ? AND active = 1', String(login || '').trim().toLowerCase());
  if (!user || !checkPassword(String(password || ''), user.pass_hash)) {
    const n = (a?.count || 0) + 1;
    attempts.set(ip, { count: n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token, user_id) VALUES(?, ?)', token, user.id);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MAX_AGE });
  res.json({ ok: true });
}

export function logout(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) { destroySandbox(token); run('DELETE FROM sessions WHERE token = ?', token); }
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  const demo = getSandbox(token);
  if (demo) {
    // все запросы демо-сессии идут в её собственную базу в памяти
    return withDb(demo.db, () => {
      const u = get('SELECT id, login, name, role, color FROM users WHERE id = ?', demo.userId);
      req.user = { ...u, demo: true };
      req.demo = demo;
      next();
    });
  }
  const user = token && get(
    `SELECT u.id, u.login, u.name, u.role, u.color FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1`, token);
  if (!user) return res.status(401).json({ error: 'Нужно войти' });
  req.user = user;
  next();
}

export function requireChief(req, res, next) {
  if (req.user?.role !== 'chief') return res.status(403).json({ error: 'Только для шефа' });
  next();
}
