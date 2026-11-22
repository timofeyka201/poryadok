import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';

const dataDir = mkdtempSync(join(tmpdir(), 'poryadok-ical-'));
process.env.DATA_DIR = dataDir;
const { all, createSchema, get, mainDb, run, setSetting, withDb } = await import('../server/db.js');
const { createCleaning } = await import('../server/cleanings.js');
const { syncIcal } = await import('../server/ical.js');

after(() => {
  mainDb.close();
  rmSync(dataDir, { recursive: true });
});

const yesterday = '2026-11-21';
const today = '2026-11-22';
const tomorrow = '2026-11-23';
const feed = { name: 'Test', url: 'https://calendar.example/booking.ics' };
const event = (uid, end) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:20261120\nDTEND;VALUE=DATE:${end.replaceAll('-', '')}\nEND:VEVENT`;
const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');

function scenario(name, fn) {
  test(name, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 22, 12) });
    const db = new DatabaseSync(':memory:');
    createSchema(db);
    t.after(() => db.close());
    let response = calendar();
    t.mock.method(globalThis, 'fetch', async () => new Response(response));
    await withDb(db, async () => {
      setSetting('ical', [feed]);
      await fn((body) => { response = body; });
    });
  });
}

const linked = (uid) => get(`SELECT c.* FROM cleanings c
  JOIN ical_links l ON l.cleaning_id = c.id WHERE l.uid = ?`, `Test:${uid}`);

scenario('a returning booking gets a new cleaning after automatic cancellation', async (send) => {
  send(calendar(event('booking', today)));
  await syncIcal();
  const first = linked('booking');
  send(calendar());
  await syncIcal();
  assert.equal(linked('booking').status, 'cancelled');

  send(calendar(event('booking', today)));
  await syncIcal();
  const replacement = linked('booking');
  assert.equal(replacement.date, today);
  assert.equal(replacement.status, 'unassigned');
  assert.notEqual(replacement.id, first.id);
  assert.equal(get('SELECT status FROM cleanings WHERE id = ?', first.id).status, 'cancelled');
  await syncIcal();
  assert.equal(linked('booking').id, replacement.id);
  assert.equal(all('SELECT id FROM cleanings').length, 2);
  assert.equal(get('SELECT checkout FROM stays').checkout, `${today} 11:00`);
});

scenario('a completed report cannot satisfy a different checkout', async (send) => {
  const report = createCleaning({ date: yesterday, source: 'ical' });
  run("UPDATE cleanings SET status = 'done', finished_at = ? WHERE id = ?", `${yesterday} 12:00:00`, report.id);
  run('INSERT INTO ical_links(uid, cleaning_id) VALUES (?, ?)', 'Test:booking', report.id);
  const early = createCleaning({ date: today });
  run("UPDATE cleanings SET status = 'done', finished_at = ? WHERE id = ?", `${today} 09:00:00`, early.id);

  send(calendar(event('booking', today), event('alias', today)));
  await syncIcal();
  const replacement = linked('booking');
  assert.equal(replacement.status, 'unassigned');
  assert.equal(replacement.date, today);
  assert.equal(linked('alias').id, replacement.id);
  assert.equal(get('SELECT date FROM cleanings WHERE id = ?', report.id).date, yesterday);
  run("UPDATE cleanings SET status = 'done', finished_at = ? WHERE id = ?", `${today} 12:00:00`, replacement.id);
  await syncIcal();
  assert.equal(linked('booking').id, replacement.id);
  assert.equal(all('SELECT id FROM cleanings').length, 3);
});

scenario('a moved booking keeps its accepted assignment when it is the only linked checkout', async (send) => {
  send(calendar(event('booking', tomorrow)));
  await syncIcal();
  const original = linked('booking');
  const cleaner = run("INSERT INTO users(login, name, role, pass_hash) VALUES ('cleaner','Cleaner','cleaner','unused')");
  run("UPDATE cleanings SET status = 'accepted', cleaner_id = ?, reminded = 1 WHERE id = ?", cleaner.lastInsertRowid, original.id);

  send(calendar(event('booking', today)));
  await syncIcal();
  const updated = linked('booking');
  assert.equal(updated.id, original.id);
  assert.equal(updated.date, today);
  assert.equal(updated.status, 'accepted');
  assert.equal(updated.cleaner_id, Number(cleaner.lastInsertRowid));
  assert.equal(updated.reminded, 0);
});

scenario('moving one booking does not move the cleaning still needed by another booking', async (send) => {
  send(calendar(event('booking', today), event('alias', today)));
  await syncIcal();
  const original = linked('booking');
  send(calendar(event('booking', tomorrow), event('alias', today)));
  await syncIcal();
  assert.equal(linked('alias').id, original.id);
  assert.equal(linked('alias').date, today);
  assert.equal(linked('booking').date, tomorrow);
  assert.notEqual(linked('booking').id, original.id);
});

scenario('an invalid feed does not cancel jobs, and a manual cancellation stays in effect', async (send) => {
  send(calendar(event('keep', today), event('cancel', tomorrow)));
  await syncIcal();
  const cancelled = linked('cancel');
  run("UPDATE cleanings SET status = 'cancelled', cancelled_manually = 1 WHERE id = ?", cancelled.id);
  send('<html>Service unavailable</html>');
  assert.equal((await syncIcal()).ok, false);
  assert.equal(linked('keep').status, 'unassigned');

  send(calendar(event('keep', today), event('cancel', tomorrow)));
  await syncIcal();
  assert.equal(linked('cancel').id, cancelled.id);
  assert.equal(linked('cancel').status, 'cancelled');
  assert.equal(all('SELECT id FROM cleanings').length, 2);
});

test('the overview and cleaner calendar use the new cleaning after assignment', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 22, 12) });
  const { api } = await import('../server/api.js');
  const app = express();
  app.use(cookieParser(), express.json(), api);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => url === feed.url
    ? Promise.resolve(new Response(calendar(event('booking', today))))
    : realFetch(url, options));
  const request = async (path, { user = 'chief', method = 'GET', body } = {}) => {
    const response = await fetch(`${address}${path}`, {
      method, headers: { Cookie: `sid=${user}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const users = {};
  for (const role of ['chief', 'cleaner']) {
    const user = run('INSERT INTO users(login, name, role, pass_hash) VALUES (?,?,?,?)', role, role, role, 'unused');
    users[role] = Number(user.lastInsertRowid);
    run('INSERT INTO sessions(token, user_id) VALUES (?,?)', role, users[role]);
  }
  const report = createCleaning({ date: yesterday, source: 'ical' });
  run("UPDATE cleanings SET status = 'done', finished_at = ? WHERE id = ?", `${yesterday} 12:00:00`, report.id);
  run('INSERT INTO ical_links(uid, cleaning_id) VALUES (?, ?)', 'Test:booking', report.id);
  setSetting('ical', [feed]);
  assert.equal((await request('/apartment-status')).state, 'unknown');

  assert.equal((await request('/ical/sync', { method: 'POST' })).ok, true);
  const overview = await request('/apartment-status');
  assert.equal(overview.state, 'dirty');
  assert.equal(overview.cleaning.date, today);
  assert.equal(overview.cleaning.status, 'unassigned');
  assert.notEqual(overview.cleaning.id, report.id);

  await request(`/cleanings/${overview.cleaning.id}`, { method: 'PATCH', body: { cleaner_id: users.cleaner } });
  const list = await request(`/cleanings?from=${today}&to=${today}&status=assigned`, { user: 'cleaner' });
  assert.deepEqual(list.map(({ id }) => id), [overview.cleaning.id]);
});
