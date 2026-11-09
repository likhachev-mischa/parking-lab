import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeSnapshot } from './backup.mjs';
import { AppError } from './store.mjs';

const derive = promisify(scrypt);
const SESSION_SECONDS = 12 * 60 * 60;
const contentTypes = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new AppError(415, 'Ожидается JSON.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8192) {
      req.resume();
      throw new AppError(413, 'Запрос слишком большой.');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AppError(400, 'Некорректный объект JSON.');
  }
}

function credentials(input) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const { password } = input;
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
      typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new AppError(400, 'Укажите корректный email и пароль длиной от 8 до 128 символов.');
  }
  return { email, password };
}

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${(await derive(password, salt, 64)).toString('hex')}`;
}

export function createApp(store, {
  adminEmail = 'admin@forum.test', adminPassword = '', secureCookie = false,
  backupToken = '', backupDir, staticDir = resolve('dist'),
} = {}) {
  const sessions = new Map();
  const admin = { id: null, email: adminEmail, role: 'admin' };
  const cookie = (token, age) =>
    `forum_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookie ? '; Secure' : ''}`;

  function sessionToken(req) {
    return req.headers.cookie?.match(/(?:^|;\s*)forum_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  }

  function identify(req) {
    const token = sessionToken(req);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    if (session.role === 'admin') return admin;
    const user = store.userById(session.id);
    return user ? { ...user, role: 'visitor' } : null;
  }

  function login(req, res, user, status) {
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token);
    sessions.delete(sessionToken(req));
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { id: user.id, role: user.role, expires: now + SESSION_SECONDS * 1000 });
    res.setHeader('set-cookie', cookie(token, SESSION_SECONDS));
    json(res, status, user);
  }

  async function route(req, res) {
    const method = req.method;
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (method === 'GET' && pathname === '/healthz') {
      store.health();
      return json(res, 200, { status: 'ok' });
    }
    if (method === 'POST' && pathname === '/internal/backup' && backupToken &&
        equal(req.headers.authorization ?? '', `Bearer ${backupToken}`)) {
      return json(res, 201, { file: basename(writeSnapshot(store, backupDir)) });
    }
    if (method === 'POST' && pathname === '/api/register') {
      const { email, password } = credentials(await body(req));
      if (email === adminEmail) throw new AppError(409, 'Этот адрес зарезервирован.');
      const user = store.register(email, await passwordHash(password));
      return login(req, res, { ...user, role: 'visitor' }, 201);
    }
    if (method === 'POST' && pathname === '/api/login') {
      const { email, password } = credentials(await body(req));
      if (email === adminEmail && adminPassword && equal(adminPassword, password)) return login(req, res, admin, 200);
      const user = email === adminEmail ? null : store.userByEmail(email);
      const computed = await passwordHash(password, user?.password_hash.split(':')[0] ?? 'invalid-account');
      if (!user || !equal(user.password_hash, computed)) throw new AppError(401, 'Неверный email или пароль.');
      return login(req, res, { id: user.id, email, role: 'visitor' }, 200);
    }
    if (method === 'POST' && pathname === '/api/logout') {
      sessions.delete(sessionToken(req));
      res.setHeader('set-cookie', cookie('', 0));
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && pathname === '/api/malls') return json(res, 200, store.listMalls());
    if (method === 'GET' && pathname === '/api/availability') {
      const bookingId = searchParams.get('bookingId');
      const actor = bookingId ? identify(req) : null;
      if (bookingId && actor?.role !== 'visitor') throw new AppError(403, 'Требуется аккаунт посетителя.');
      return json(res, 200, store.availability({
        mallId: searchParams.get('mallId'),
        start: Number(searchParams.get('start')),
        end: Number(searchParams.get('end')),
      }, actor, bookingId || undefined));
    }

    if (pathname.startsWith('/api/')) {
      const actor = identify(req);
      if (method === 'GET' && pathname === '/api/session') return json(res, 200, actor);
      if (!actor) throw new AppError(401, 'Войдите в аккаунт.');
      if (pathname === '/api/bookings' || pathname.startsWith('/api/bookings/')) {
        if (actor.role !== 'visitor') throw new AppError(403, 'Бронирование доступно посетителям.');
        if (pathname === '/api/bookings' && method === 'GET') return json(res, 200, store.bookingsFor(actor.id));
        if (pathname === '/api/bookings' && method === 'POST') {
          return json(res, 201, store.saveBooking(await body(req), actor));
        }
        const match = pathname.match(/^\/api\/bookings\/([a-f0-9-]{36})$/);
        if (match && method === 'PUT') return json(res, 200, store.saveBooking(await body(req), actor, match[1]));
        if (match && method === 'DELETE') return json(res, 200, store.cancelBooking(match[1], actor));
      }
      if (pathname.startsWith('/api/admin/')) {
        if (actor.role !== 'admin') throw new AppError(403, 'Требуется доступ администратора.');
        const floor = pathname.match(/^\/api\/admin\/floors\/([a-z]+)\/(\d+)$/);
        if (floor && method === 'PUT') {
          return json(res, 200, store.resize(floor[1], Number(floor[2]), (await body(req)).capacity, actor));
        }
        const audit = pathname.match(/^\/api\/admin\/audit\/(booking|capacity)$/);
        if (audit && method === 'GET') {
          const before = Number(searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
          if (!Number.isSafeInteger(before) || before < 1) throw new AppError(400, 'Неверный курсор журнала.');
          return json(res, 200, store.audit(audit[1], before));
        }
      }
    }

    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if ((method === 'GET' || method === 'HEAD') && /^(index\.html|app\.(js|css))$/.test(file)) {
      const data = await readFile(resolve(staticDir, file)).catch(error => {
        if (error.code === 'ENOENT') throw new AppError(404, 'Клиент не собран. Выполните npm run build.');
        throw error;
      });
      res.writeHead(200, {
        'content-type': contentTypes[file.split('.').at(-1)],
        'content-length': data.length,
        'cache-control': 'no-cache',
        'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'x-content-type-options': 'nosniff',
      });
      return res.end(method === 'HEAD' ? undefined : data);
    }
    throw new AppError(404, 'Маршрут не найден.');
  }

  return createServer((req, res) => {
    route(req, res).catch(error => {
      if (error instanceof AppError) return json(res, error.status, { error: error.message });
      console.error(error);
      return json(res, 500, { error: 'Внутренняя ошибка сервера.' });
    });
  });
}
