import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { ContaboDns, MockDns } from './dns.js';
import { createApp } from './app.js';

process.umask(0o077);
try {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);
  const provider = config.provider === 'mock' ? new MockDns(db) : new ContaboDns(config.contabo);
  const server = createApp({ config, db, provider }).listen(config.port, config.host, () => {
    console.log(`DynDNS gestartet, Port ${config.port}, DNS: ${config.provider}`);
  });
  server.on('error', () => { console.error('Server konnte nicht gestartet werden. Host und Port prüfen.'); db.close(); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 15000).unref();
  });
} catch (error) {
  console.error(`Start fehlgeschlagen: ${error.message}`);
  process.exitCode = 1;
}
