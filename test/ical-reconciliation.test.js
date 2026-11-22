import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'poryadok-ical-'));
process.env.DATA_DIR = dataDir;
const { all, createSchema, get, mainDb, run, setSetting, withDb } = await import('../server/db.js');
const { createCleaning } = await import('../server/cleanings.js');
const { syncIcal } = await import('../server/ical.js');

after(() => {
  mainDb.close();
  rmSync(dataDir, { recursive: true });
});

const day = '2026-11-22';
const later = '2026-11-24';
const calendar = (...entries) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...entries, 'END:VCALENDAR'].join('\r\n');
const date = (value) => value.replaceAll('-', '');
const booking = (uid, end, { start = '2026-11-20', sequence = 0 } = {}) =>
  `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${date(start)}\nDTEND:${date(end)}\nSEQUENCE:${sequence}\nEND:VEVENT`;
const cancelled = (uid, sequence) => `BEGIN:VEVENT\nUID:${uid}\nSTATUS:CANCELLED\nSEQUENCE:${sequence}\nEND:VEVENT`;
const feedA = { name: 'Test', url: 'https://example.test/one.ics' };
const feedB = { name: 'Test', url: 'https://example.test/two.ics' };
const cleaning = (id) => get('SELECT * FROM cleanings WHERE id = ?', id);
const activeOn = (date) => all("SELECT * FROM cleanings WHERE date = ? AND status <> 'cancelled' ORDER BY id", date);

function scenario(name, fn) {
  test(name, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 22, 14) });
    const db = new DatabaseSync(':memory:');
    createSchema(db);
    t.after(() => db.close());
    const replies = new Map([[feedA.url, calendar()], [feedB.url, calendar()]]);
    const mock = t.mock.method(globalThis, 'fetch', async (url) => {
      const reply = replies.get(url);
      return typeof reply === 'function' ? reply() : new Response(reply);
    });
    await withDb(db, async () => {
      setSetting('ical', [feedA]);
      await fn((body, feed = feedA) => replies.set(feed.url, body), mock);
    });
  });
}

scenario('an automatically cancelled booking can return with the same UID and sync is idempotent', async (send) => {
  send(calendar(booking('one', day)));
  await syncIcal();
  const first = activeOn(day)[0];
  send(calendar(booking('one', day), cancelled('one', 1)));
  await syncIcal();
  assert.equal(cleaning(first.id).status, 'cancelled');
  assert.equal(all('SELECT id FROM stays').length, 0);
  send(calendar(booking('one', day, { sequence: 2 })));
  await syncIcal();
  const second = activeOn(day)[0];
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'unassigned');
  await syncIcal();
  assert.deepEqual(activeOn(day).map(({ id }) => id), [second.id]);
});

scenario('manual cancellation blocks a duplicate of the same booking but not a replacement', async (send) => {
  send(calendar(booking('one', day)));
  await syncIcal();
  const first = activeOn(day)[0];
  run("UPDATE cleanings SET status = 'cancelled', cancelled_manually = 1 WHERE id = ?", first.id);
  setSetting('ical', [feedA, feedB]);
  send(calendar(booking('duplicate', day)), feedB);
  await syncIcal();
  assert.deepEqual(activeOn(day), []);
  assert.equal(all('SELECT id FROM stays').length, 1);

  send(calendar());
  send(calendar(booking('replacement', day, { start: '2026-11-21' })), feedB);
  await syncIcal();
  assert.equal(activeOn(day).length, 1);
  assert.equal(cleaning(first.id).cancelled_manually, 1);
});

scenario('moving one of two linked bookings leaves the accepted cleaning for the remaining checkout', async (send) => {
  setSetting('ical', [feedA, feedB]);
  send(calendar(booking('shared-uid', day)));
  send(calendar(booking('shared-uid', day)), feedB);
  await syncIcal();
  const original = activeOn(day)[0];
  assert.equal(activeOn(day).length, 1);
  run("UPDATE cleanings SET status = 'accepted' WHERE id = ?", original.id);

  // The moving calendar is still read first. Its display name does not identify the source.
  setSetting('ical', [{ ...feedA, name: 'Renamed' }, feedB]);
  send(calendar(booking('shared-uid', later)));
  await syncIcal();
  assert.equal(cleaning(original.id).date, day);
  assert.equal(cleaning(original.id).status, 'accepted');
  assert.equal(activeOn(later).length, 1);
  assert.equal(all('SELECT id FROM stays').length, 2);
});

scenario('moving an assigned booking without another checkout keeps its cleaner and resets reminders', async (send) => {
  send(calendar(booking('move', day)));
  await syncIcal();
  const original = activeOn(day)[0];
  const id = run("INSERT INTO users(login, name, role, pass_hash) VALUES ('cleaner', 'Cleaner', 'cleaner', '-')").lastInsertRowid;
  run("UPDATE cleanings SET status = 'accepted', cleaner_id = ?, reminded = 1 WHERE id = ?", id, original.id);
  setSetting('ical', [{ ...feedA, name: 'Renamed' }]);
  send(calendar(booking('move', later)));
  await syncIcal();
  const moved = cleaning(original.id);
  assert.equal(moved.date, later);
  assert.equal(moved.status, 'accepted');
  assert.equal(moved.reminded, 0);
  assert.equal(moved.cleaner_id, Number(id));
  await syncIcal();
  assert.equal(all('SELECT id FROM notifications WHERE user_id = ?', id).length, 1);
});

scenario('a report actually done the day before cannot cover today, and active work is not moved', async (send) => {
  const old = createCleaning({ date: day, source: 'ical' });
  run("UPDATE cleanings SET status = 'done', started_at = ?, finished_at = ? WHERE id = ?",
    '2026-11-21 12:38:00', '2026-11-21 12:42:00', old.id);
  run("INSERT INTO ical_links(uid, cleaning_id) VALUES ('Test:one', ?)", old.id);
  send(calendar(booking('one', day)));
  await syncIcal();
  const current = activeOn(day).find((c) => c.status === 'unassigned');
  assert.ok(current);
  assert.equal(cleaning(old.id).status, 'done');
  run("UPDATE cleanings SET status = 'in_progress' WHERE id = ?", current.id);
  send(calendar(booking('one', later)));
  await syncIcal();
  assert.equal(cleaning(current.id).date, day);
  assert.equal(cleaning(current.id).status, 'in_progress');
  assert.equal(activeOn(later)[0].status, 'unassigned');
});

scenario('a completed cleaning for the same booking is not recreated after an early checkout', async (send) => {
  send(calendar(booking('one', day)));
  await syncIcal();
  const c = activeOn(day)[0];
  run("UPDATE cleanings SET status = 'done', finished_at = ? WHERE id = ?", `${day} 09:00:00`, c.id);
  await syncIcal();
  assert.deepEqual(activeOn(day).map(({ id }) => id), [c.id]);
});

scenario('a malformed or partly unavailable calendar does not modify the previous snapshot', async (send) => {
  setSetting('ical', [feedA, feedB]);
  send(calendar(booking('one', day)));
  await syncIcal();
  const original = activeOn(day)[0];
  const originalStays = all('SELECT * FROM stays');
  send(calendar(booking('new', later)));
  send(calendar(booking('broken', '2026-11-39')), feedB);
  assert.equal((await syncIcal()).ok, false);
  assert.equal(cleaning(original.id).status, 'unassigned');
  assert.deepEqual(all('SELECT * FROM stays'), originalStays);
  assert.deepEqual(activeOn(later), []);

  send(() => new Response(null, { status: 503 }), feedB);
  assert.equal((await syncIcal()).ok, false);
  assert.deepEqual(all('SELECT * FROM stays'), originalStays);
  send(calendar(), feedB);
  assert.equal((await syncIcal()).ok, true);
  assert.equal(cleaning(original.id).status, 'cancelled');
  assert.equal(activeOn(later).length, 1);
});

scenario('concurrent syncs share a run and a changed feed list invalidates an in-flight snapshot', async (send, fetchMock) => {
  let release;
  send(() => new Promise((resolve) => { release = resolve; }));
  const first = syncIcal();
  assert.equal(syncIcal(), first);
  setSetting('ical', [feedB]);
  release(new Response(calendar(booking('obsolete', day))));
  assert.equal((await first).ok, false);
  assert.deepEqual(activeOn(day), []);
  assert.equal(fetchMock.mock.callCount(), 1);
  send(calendar(booking('new', day)), feedB);
  assert.equal((await syncIcal()).ok, true);
  assert.equal(activeOn(day).length, 1);
  setSetting('ical', []);
  await syncIcal();
  assert.deepEqual(activeOn(day), []);
  assert.equal(all('SELECT * FROM stays').length, 0);
});
