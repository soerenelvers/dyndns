import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(target)) {
  console.log('Vorhandene .env bleibt unverändert.');
} else {
  const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  writeFileSync(target, template.replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${randomBytes(48).toString('hex')}`), { flag: 'wx', mode: 0o600 });
  console.log('Lokale .env erstellt: Testkonto und simuliertes DNS, nur auf 127.0.0.1.');
}
