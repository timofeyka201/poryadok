import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';

test('cleaning cards use actual work dates and current booking data', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 22, 14) });
  const dataDir = mkdtempSync(join(tmpdir(), 'poryadok-schedule-'));
  process.env.DATA_DIR = dataDir;
  const { mainDb, run, setSetting } = await import('../server/db.js');
  t.after(() => {
    mainDb.close();
    rmSync(dataDir, { recursive: true });
  });
  const { createCleaning } = await import('../server/cleanings.js');
  const { api } = await import('../server/api.js');
  const server = express().use(cookieParser(), express.json(), api).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const chiefId = run("INSERT INTO users(login, name, role, pass_hash) VALUES ('chief', 'Chief', 'chief', '-')").lastInsertRowid;
  run("INSERT INTO sessions(token, user_id) VALUES ('local-test', ?)", chiefId);
  const past = createCleaning({ date: '2026-11-22', source: 'ical', next_checkin: '2026-12-30' });
  run("UPDATE cleanings SET status = 'done', started_at = ?, finished_at = ? WHERE id = ?",
    '2026-11-21 12:38:00', '2026-11-21 12:42:00', past.id);
  const upcoming = createCleaning({ date: '2026-11-23', source: 'ical', end_time: '14:00', next_checkin: '2026-11-27',
    note: 'В этот же день заезд новых гостей — уборка срочная' });
  run("UPDATE cleanings SET status = 'accepted' WHERE id = ?", upcoming.id);
  run("INSERT INTO ical_links(uid, cleaning_id) VALUES ('Test:current', ?)", upcoming.id);
  const manual = createCleaning({ date: '2026-11-24', end_time: '13:00' });

  const feed = 'https://calendar.example/reservations.ics';
  setSetting('ical', [{ name: 'Test', url: feed }]);
  const event = (uid, start, end) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\nEND:VEVENT`;
  const calendar = (...events) => ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\r\n');
  let body = calendar(event('current', '20261122', '20261123'), event('next', '20261123', '20261127'));
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => url === feed
    ? Promise.resolve(new Response(body)) : realFetch(url, options));
  const request = async (path, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${path}`, {
      method, headers: { Cookie: 'sid=local-test' },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await request('ical/sync', 'POST')).ok, true);

  const previous = await request(`cleanings/${past.id}`);
  assert.equal(previous.date, '2026-11-21');
  assert.equal(previous.scheduled_date, '2026-11-22');
  assert.equal(previous.next_checkin, '2026-11-22');
  assert.deepEqual((await request('cleanings?from=2026-11-21&to=2026-11-21')).map(({ id }) => id), [past.id]);
  assert.deepEqual(await request('cleanings?from=2026-11-22&to=2026-11-22'), []);
  const accepted = await request(`cleanings/${upcoming.id}`);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.next_checkin, '2026-11-23');
  assert.equal(accepted.end_time, accepted.next_checkin_time);

  // Перенос выезда и отмена заезда меняют ту же карточку принятой уборки.
  body = calendar(event('current', '20261122', '20261124'), event('replacement', '20261126', '20261128'));
  await request('ical/sync', 'POST');
  const moved = await request(`cleanings/${upcoming.id}`);
  assert.equal(moved.date, '2026-11-24');
  assert.equal(moved.status, 'accepted');
  assert.equal(moved.next_checkin, '2026-11-26');
  assert.equal(moved.end_time, null);
  assert.equal(moved.note, null);
  assert.equal((await request(`cleanings/${manual.id}`)).end_time, '13:00');

  body = '<html>Service unavailable</html>';
  assert.equal((await request('ical/sync', 'POST')).ok, false);
  assert.equal((await request(`cleanings/${upcoming.id}`)).next_checkin, '2026-11-26');

  body = calendar(event('current', '20261122', '20261124'));
  await request('ical/sync', 'POST');
  assert.equal((await request(`cleanings/${upcoming.id}`)).next_checkin, null);
});
