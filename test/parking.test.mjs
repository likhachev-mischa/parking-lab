import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeSnapshot } from '../server/backup.mjs';
import { createApp } from '../server/http.mjs';
import { openStore } from '../server/store.mjs';

const HOUR = 3_600_000;
const start = Date.parse('2030-01-02T10:00:00Z');
const now = start - HOUR;
const adminEmail = 'admin@forum.test';
const adminPassword = 'admin-test-password';
const north = { mallId: 'north', start, end: start + HOUR };

test('HTTP: registration, hourly pricing, concurrency, booking ownership and audits', async t => {
  const backupDir = mkdtempSync(join(tmpdir(), 'forum-http-'));
  const store = openStore(':memory:', { rate: 125, clock: () => now });
  const server = createApp(store, { adminEmail, adminPassword, backupToken: 'test-token', backupDir });
  t.after(async () => {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
    store.close();
    rmSync(backupDir, { force: true, recursive: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(path, status, { method = 'GET', data, cookie, token } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(data && { 'content-type': 'application/json' }),
        ...(cookie && { cookie }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      ...(data && { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    if (status) assert.equal(response.status, status, JSON.stringify(result));
    return { status: response.status, result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  const malls = (await request('/api/malls', 200)).result;
  assert.deepEqual(malls.map(mall => mall.floors.length), [1, 1, 2]);
  await request('/api/bookings', 401, { method: 'POST', data: north });
  const admin = await request('/api/login', 200, { method: 'POST', data: { email: adminEmail, password: adminPassword } });
  const signup = email => request('/api/register', 201, {
    method: 'POST', data: { email, password: 'visitor-password' },
  });
  const first = await signup('first@example.test');
  const second = await signup('second@example.test');
  const resize = (capacity, cookie, status) => request('/api/admin/floors/north/1', status, {
    method: 'PUT', data: { capacity }, cookie,
  });
  await resize(1, first.cookie, 403);
  await resize(1, admin.cookie, 200);
  await request('/api/bookings', 400, { method: 'POST', data: { ...north, end: north.end + 60_000 }, cookie: first.cookie });
  const availability = (input, cookie) => request(`/api/availability?${new URLSearchParams(input)}`, 200, { cookie });
  const quote = await availability({ ...north, end: start + 2 * HOUR });
  assert.equal(quote.result.total, 250);
  assert.equal(quote.result.floors[0].available, 1);

  const compete = [first, second].map(({ cookie }) => request('/api/bookings', null, { method: 'POST', data: north, cookie }));
  const results = await Promise.all(compete);
  assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
  const winnerIndex = results.findIndex(row => row.status === 201);
  const { cookie: owner, result: user } = [first, second][winnerIndex];
  const { cookie: stranger } = [first, second][1 - winnerIndex];
  const booking = results[winnerIndex].result;
  assert.equal(booking.spot, 1);
  assert.equal(booking.created_by, user.email);
  assert.equal(booking.total_rub, 125);
  assert.equal((await availability(north)).result.floors[0].available, 0);
  assert.equal((await availability({ ...north, bookingId: booking.id }, owner)).result.floors[0].available, 1);
  assert.equal((await availability({ ...north, start: north.end, end: north.end + HOUR })).result.floors[0].available, 1);
  await resize(0, admin.cookie, 409);
  const route = `/api/bookings/${booking.id}`;
  await request(route, 404, { method: 'DELETE', cookie: stranger });
  const edited = await request(route, 200, { method: 'PUT', data: { ...north, end: start + 2 * HOUR }, cookie: owner });
  assert.equal(edited.result.total_rub, 250);
  await request(route, 200, { method: 'DELETE', cookie: owner });
  await resize(0, admin.cookie, 200);
  const audit = (type, cookie = admin.cookie, status = 200) => request(`/api/admin/audit/${type}`, status, { cookie });
  assert.deepEqual((await audit('booking')).result.entries.map(row => row.action), ['cancel', 'update', 'create']);
  const changes = (await audit('capacity')).result.entries;
  assert.equal(changes[0].actor, adminEmail);
  assert.equal(changes[0].source, 'web');
  assert.equal(changes[0].previous.capacity, 1);
  assert.equal(changes[0].next.capacity, 0);
  await audit('capacity', owner, 403);

  await request('/internal/backup', 404, { method: 'POST' });
  const { result: { file } } = await request('/internal/backup', 201, { method: 'POST', token: 'test-token' });
  const snapshot = JSON.parse(readFileSync(join(backupDir, file), 'utf8'));
  assert.equal(snapshot.tables.bookings[0].status, 'cancelled');
  assert.equal(snapshot.tables.users.length, 2);
  assert.equal(snapshot.tables.audit.length, 9);
});

test('SQLite: full JSON round-trip and rollback on corrupt backup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forum-restore-'));
  const store = openStore(join(directory, 'source.sqlite'), { clock: () => now });
  const destination = openStore(join(directory, 'target.sqlite'), { seed: false, clock: () => now });
  t.after(() => {
    store.close();
    destination.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const visitor = store.register('driver@example.test', 'test-hash');
  store.resize('center', 1, 0, { email: adminEmail });
  const booking = store.saveBooking({ ...north, mallId: 'center' }, visitor);
  assert.equal(booking.level, 2);
  const snapshot = JSON.parse(readFileSync(writeSnapshot(store, directory), 'utf8'));
  destination.restore(snapshot);
  const restored = () => JSON.parse(JSON.stringify(destination.snapshot()));
  assert.deepEqual(restored(), snapshot);

  const corrupt = structuredClone(snapshot);
  corrupt.tables.bookings.push({ ...booking, id: 'duplicate-slot' });
  assert.throws(() => destination.restore(corrupt), /конфликт/);
  assert.deepEqual(restored(), snapshot);
});
