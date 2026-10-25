import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { all, run, DATA_DIR } from './db.js';

// VAPID-ключи для push-уведомлений генерируются один раз и хранятся в data/
const vapidFile = path.join(DATA_DIR, 'vapid.json');
if (!fs.existsSync(vapidFile)) {
  fs.writeFileSync(vapidFile, JSON.stringify(webpush.generateVAPIDKeys()));
}
const vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

export const vapidPublicKey = vapid.publicKey;

export function saveSubscription(userId, sub) {
  run(`INSERT INTO push_subs(endpoint, user_id, data) VALUES(?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, data = excluded.data`,
    sub.endpoint, userId, JSON.stringify(sub));
}

/** Сохраняет уведомление в ленту и отправляет push на все устройства пользователя. */
export function notify(userIds, title, body = '', link = '') {
  const ids = [...new Set([].concat(userIds).filter(Boolean))];
  for (const uid of ids) {
    run('INSERT INTO notifications(user_id, title, body, link) VALUES(?,?,?,?)', uid, title, body, link);
    for (const s of all('SELECT endpoint, data FROM push_subs WHERE user_id = ?', uid)) {
      webpush.sendNotification(JSON.parse(s.data), JSON.stringify({ title, body, link }))
        .catch((err) => {
          if (err.statusCode === 404 || err.statusCode === 410) run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
        });
    }
  }
}

export const chiefIds = () => all("SELECT id FROM users WHERE role = 'chief' AND active = 1").map((u) => u.id);
export const cleanerIds = () => all("SELECT id FROM users WHERE role = 'cleaner' AND active = 1").map((u) => u.id);
