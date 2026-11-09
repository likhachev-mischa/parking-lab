import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';

export const dbPath = process.env.DB_PATH || resolve('data/forum.sqlite');
export const backupDir = process.env.BACKUP_DIR || resolve('data/backups');

export function writeSnapshot(store, directory = backupDir) {
  const snapshot = store.snapshot();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `forum-${snapshot.exportedAt.replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`;
  const file = join(directory, name);
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

async function run([command, file]) {
  if (command === 'remote' && file) {
    const response = await fetch(new URL('/internal/backup', file), {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.BACKUP_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Ошибка выгрузки: HTTP ${response.status}`);
    console.log((await response.json()).file);
    return;
  }
  if (command === 'export' && !file) {
    const store = openStore(dbPath, { seed: false });
    try {
      if (store.listMalls().some(mall => !mall.floors.length)) throw new Error('Сначала запустите приложение.');
      console.log(writeSnapshot(store));
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'restore' && file) {
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    const store = openStore(dbPath, { seed: false });
    try {
      store.restore(snapshot);
      console.log(`Восстановлена копия ${basename(file)} от ${snapshot.exportedAt}`);
    } finally {
      store.close();
    }
    return;
  }
  throw new Error('Использование: npm run backup -- export | restore <файл>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
