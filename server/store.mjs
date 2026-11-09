import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOUR = 3_600_000;
const malls = [
  { id: 'north', name: 'Форум Север', capacities: [60] },
  { id: 'southwest', name: 'Форум Юго-Запад', capacities: [45] },
  { id: 'center', name: 'Форум Центр', capacities: [70, 60] },
];
const backupColumns = {
  users: 'id email password_hash created_at',
  floors: 'mall_id level capacity created_by updated_by created_at updated_at',
  bookings: 'id user_id mall_id level spot starts_at ends_at rate_rub total_rub status created_by updated_by created_at updated_at',
  audit: 'id entity_type entity_id action actor source changed_at previous next',
};

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function openStore(path, { rate = 100, clock = Date.now, seed = true } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS floors (
      mall_id TEXT NOT NULL, level INTEGER NOT NULL, capacity INTEGER NOT NULL CHECK (capacity BETWEEN 0 AND 10000),
      created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (mall_id, level)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), mall_id TEXT NOT NULL, level INTEGER NOT NULL,
      spot INTEGER NOT NULL CHECK (spot > 0), starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      rate_rub INTEGER NOT NULL CHECK (rate_rub > 0), total_rub INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
      created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (mall_id, level) REFERENCES floors(mall_id, level),
      CHECK (starts_at % 3600000 = 0 AND ends_at % 3600000 = 0 AND ends_at > starts_at),
      CHECK (total_rub = (ends_at - starts_at) / 3600000 * rate_rub)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS bookings_slots ON bookings (mall_id, status, starts_at, ends_at);
    CREATE INDEX IF NOT EXISTS bookings_owner ON bookings (user_id, starts_at);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL CHECK (entity_type IN ('booking', 'capacity')),
      entity_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('create', 'update', 'cancel')),
      actor TEXT NOT NULL, source TEXT NOT NULL, changed_at INTEGER NOT NULL, previous TEXT, next TEXT NOT NULL,
      CHECK (previous IS NULL OR json_valid(previous)), CHECK (json_valid(next))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audit_entity ON audit (entity_type, id);
  `);

  function transaction(work, mode = 'IMMEDIATE') {
    db.exec(`BEGIN ${mode}`);
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function log(type, id, action, actor, before, after, source = 'web') {
    db.prepare(`INSERT INTO audit (entity_type, entity_id, action, actor, source, changed_at, previous, next)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      type, id, action, actor, source, after.updated_at, before ? JSON.stringify(before) : null, JSON.stringify(after),
    );
  }

  const floor = db.prepare('SELECT * FROM floors WHERE mall_id = ? AND level = ?');
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?');
  if (seed) transaction(() => {
    const now = clock();
    const insert = db.prepare(`INSERT OR IGNORE INTO floors
      VALUES (?, ?, ?, 'system', 'system', ?, ?)`);
    for (const mall of malls) {
      mall.capacities.forEach((capacity, index) => {
        const level = index + 1;
        if (insert.run(mall.id, level, capacity, now, now).changes) {
          log('capacity', `${mall.id}/${level}`, 'create', 'system', null, floor.get(mall.id, level), 'seed');
        }
      });
    }
  });

  function listMalls() {
    const floors = db.prepare('SELECT * FROM floors ORDER BY level').all();
    return malls.map(({ id, name }) => ({ id, name, floors: floors.filter(row => row.mall_id === id) }));
  }

  function window({ mallId, start, end }, now) {
    if (!malls.some(mall => mall.id === mallId)) throw new AppError(400, 'Выберите торговый центр.');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < now ||
        start % HOUR || end % HOUR || end <= start || end > 253402297200000) {
      throw new AppError(400, 'Укажите будущий интервал с началом и окончанием в целый час.');
    }
    return { mallId, start, end, hours: (end - start) / HOUR };
  }

  function spaces({ mallId, start, end }, excludedId = '') {
    const occupied = db.prepare(`SELECT DISTINCT level, spot FROM bookings
      WHERE mall_id = ? AND status = 'active' AND starts_at < ? AND ends_at > ? AND id <> ?`)
      .all(mallId, end, start, excludedId);
    return db.prepare('SELECT level, capacity FROM floors WHERE mall_id = ? ORDER BY level').all(mallId)
      .map(({ level, capacity }) => {
        const used = new Set(occupied.filter(row => row.level === level && row.spot <= capacity).map(row => row.spot));
        let first = 1;
        while (used.has(first)) first++;
        return { level, capacity, available: capacity - used.size, first };
      });
  }

  function availability(input, actor, bookingId) {
    const now = clock();
    const interval = window(input, now);
    const floors = transaction(() => {
      if (bookingId) ownedBooking(bookingId, actor, now);
      return spaces(interval, bookingId);
    }, 'DEFERRED');
    return {
      floors: floors.map(({ level, capacity, available }) => ({ level, capacity, available })),
      hours: interval.hours,
      rate,
      total: interval.hours * rate,
    };
  }

  function ownedBooking(id, actor, now) {
    const row = booking.get(id);
    if (!row || row.user_id !== actor.id) throw new AppError(404, 'Бронирование не найдено.');
    if (row.status !== 'active' || row.starts_at <= now) {
      throw new AppError(409, 'Изменить можно только активное бронирование до начала парковки.');
    }
    return row;
  }

  function saveBooking(input, actor, id) {
    return transaction(() => {
      const now = clock();
      const before = id ? ownedBooking(id, actor, now) : null;
      const interval = window(input, now);
      if (before && before.mall_id === interval.mallId && before.starts_at === interval.start &&
          before.ends_at === interval.end) return before;
      const slot = spaces(interval, id).find(row => row.available > 0);
      if (!slot) throw new AppError(409, 'На выбранный интервал нет свободных мест.');
      const values = [interval.mallId, slot.level, slot.first, interval.start, interval.end, rate, interval.hours * rate];
      const bookingId = id ?? randomUUID();
      if (before) {
        db.prepare(`UPDATE bookings SET mall_id = ?, level = ?, spot = ?, starts_at = ?, ends_at = ?,
          rate_rub = ?, total_rub = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
          .run(...values, actor.email, now, bookingId);
      } else {
        db.prepare(`INSERT INTO bookings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
          .run(bookingId, actor.id, ...values, actor.email, actor.email, now, now);
      }
      const after = booking.get(bookingId);
      log('booking', bookingId, before ? 'update' : 'create', actor.email, before, after);
      return after;
    });
  }

  function cancelBooking(id, actor) {
    return transaction(() => {
      const now = clock();
      const before = ownedBooking(id, actor, now);
      db.prepare("UPDATE bookings SET status = 'cancelled', updated_by = ?, updated_at = ? WHERE id = ?")
        .run(actor.email, now, id);
      const after = booking.get(id);
      log('booking', id, 'cancel', actor.email, before, after);
      return after;
    });
  }

  function resize(mallId, level, capacity, actor) {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 10000) {
      throw new AppError(400, 'Введите целое количество мест от 0 до 10 000.');
    }
    return transaction(() => {
      const before = floor.get(mallId, level);
      if (!before) throw new AppError(404, 'Этаж не найден.');
      if (before.capacity === capacity) return before;
      const now = clock();
      const occupied = db.prepare(`SELECT MAX(spot) AS last FROM bookings
        WHERE mall_id = ? AND level = ? AND status = 'active' AND ends_at > ?`).get(mallId, level, now);
      if (occupied.last > capacity) {
        throw new AppError(409, `Место №${occupied.last} уже забронировано. Укажите вместимость не ниже этого номера.`);
      }
      db.prepare('UPDATE floors SET capacity = ?, updated_by = ?, updated_at = ? WHERE mall_id = ? AND level = ?')
        .run(capacity, actor.email, now, mallId, level);
      const after = floor.get(mallId, level);
      log('capacity', `${mallId}/${level}`, 'update', actor.email, before, after);
      return after;
    });
  }

  function register(email, hash) {
    const id = randomUUID();
    const createdAt = clock();
    const result = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
      .run(id, email, hash, createdAt);
    if (!result.changes) throw new AppError(409, 'Аккаунт с таким адресом уже существует.');
    return { id, email };
  }

  function audit(type, before) {
    const entries = db.prepare(`SELECT * FROM audit WHERE entity_type = ? AND id < ? ORDER BY id DESC LIMIT 101`)
      .all(type, before);
    const hasMore = entries.length > 100;
    if (hasMore) entries.pop();
    return {
      entries: entries.map(row => ({ ...row, previous: JSON.parse(row.previous), next: JSON.parse(row.next) })),
      next: hasMore ? entries.at(-1).id : null,
    };
  }

  function snapshot() {
    return transaction(() => ({
      version: 1,
      exportedAt: new Date(clock()).toISOString(),
      tables: Object.fromEntries(Object.keys(backupColumns).map(table => [
        table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ])),
    }), 'DEFERRED');
  }

  function restore(data) {
    const exportedAt = Date.parse(data?.exportedAt);
    if (data?.version !== 1 || !Number.isFinite(exportedAt) ||
        !Object.keys(backupColumns).every(table => Array.isArray(data.tables?.[table]))) {
      throw new Error('Неверный формат резервной копии.');
    }
    transaction(() => {
      const tables = Object.keys(backupColumns);
      for (const table of [...tables].reverse()) db.exec(`DELETE FROM ${table}`);
      for (const table of tables) {
        const columns = backupColumns[table].split(' ');
        const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
        for (const row of data.tables[table]) insert.run(...columns.map(column => row[column]));
      }
      const expectedFloors = malls.flatMap(mall => mall.capacities.map((_, index) => `${mall.id}/${index + 1}`));
      const actualFloors = db.prepare("SELECT mall_id || '/' || level AS id FROM floors").all().map(row => row.id);
      if (actualFloors.length !== expectedFloors.length || !expectedFloors.every(id => actualFloors.includes(id))) {
        throw new Error('Резервная копия содержит неверный набор этажей.');
      }
      const invalid = db.prepare(`SELECT b.id FROM bookings b JOIN floors f USING (mall_id, level)
        WHERE b.status = 'active' AND ((b.ends_at > ? AND b.spot > f.capacity) OR EXISTS (
          SELECT 1 FROM bookings other WHERE other.mall_id = b.mall_id AND other.level = b.level
          AND other.spot = b.spot AND other.status = 'active' AND other.id <> b.id
          AND b.starts_at < other.ends_at AND b.ends_at > other.starts_at
        )) LIMIT 1`).get(exportedAt);
      if (invalid) throw new Error('Резервная копия содержит конфликт бронирований.');
    });
  }

  return {
    listMalls, availability, saveBooking, cancelBooking, resize, register, audit, snapshot, restore,
    userByEmail: email => db.prepare('SELECT * FROM users WHERE email = ?').get(email),
    userById: id => db.prepare('SELECT id, email FROM users WHERE id = ?').get(id),
    bookingsFor: id => db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY starts_at DESC, id').all(id),
    health: () => db.prepare('SELECT 1').get(),
    close: () => db.close(),
  };
}
