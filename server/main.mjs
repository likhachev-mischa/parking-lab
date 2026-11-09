import { dbPath } from './backup.mjs';
import { createApp } from './http.mjs';
import { openStore } from './store.mjs';

const rate = Number(process.env.PARKING_RATE_RUB ?? 100);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const adminPassword = process.env.ADMIN_PASSWORD ?? '';
if (!Number.isInteger(rate) || rate < 1 || rate > 100_000) throw new Error('Некорректный тариф PARKING_RATE_RUB.');
if (adminPassword && (adminPassword.length < 8 || adminPassword.length > 128)) {
  throw new Error('ADMIN_PASSWORD должен содержать от 8 до 128 символов.');
}
const store = openStore(dbPath, { rate });
const server = createApp(store, {
  adminEmail: process.env.ADMIN_EMAIL?.trim().toLowerCase(),
  adminPassword,
  secureCookie: process.env.SECURE_COOKIE === 'true',
  backupToken: process.env.BACKUP_TOKEN,
});
server.listen(port, host, () => {
  console.log(`Форум Паркинг · http://${host}:${server.address().port}`);
  if (!adminPassword) console.log('Вход администратора отключён. Задайте ADMIN_PASSWORD для его включения.');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => store.close()));
}
