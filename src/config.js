import { resolve } from 'node:path';

function integer(value, fallback, min, max, name) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name}: ungültiger Wert`);
  return number;
}

export function domain(value) {
  if (typeof value !== 'string') throw new Error('Domain fehlt');
  const result = value.toLowerCase();
  if (result.length > 253 || !result.includes('.') || !result.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Ungültige Domain (ASCII/Punycode verwenden)');
  }
  return result;
}

function url(value, production) {
  const parsed = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local && !production))) {
    throw new Error('URL benötigt HTTPS; lokales HTTP ist nur in der Entwicklung erlaubt');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const config = {
    production,
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 3000, 1, 65535, 'PORT'),
    appUrl: url(env.APP_URL || 'http://localhost:3000', production),
    dataDir: resolve(env.DATA_DIR || './data'),
    sessionSecret: env.SESSION_SECRET || '',
    provider: env.DNS_PROVIDER || 'contabo',
    devAuth: env.DEV_AUTH === 'true',
    zone: domain(env.DNS_ZONE || 'example.com'),
    dynDomain: domain(env.DYNDNS_DOMAIN || 'dyn.example.com'),
    ttl: integer(env.DNS_TTL, 300, 300, 86400, 'DNS_TTL'),
    maxHosts: integer(env.MAX_HOSTS_PER_USER, 20, 1, 1000, 'MAX_HOSTS_PER_USER'),
    accountsUrl: url(env.ACCOUNTS_URL || 'https://accounts.delevel.de', production),
    issuer: url(env.OIDC_ISSUER || 'https://accounts.delevel.de/identity/realms/zugangswerk', production),
    clientId: env.OIDC_CLIENT_ID || 'dyndns',
    clientSecret: env.OIDC_CLIENT_SECRET || '',
    contabo: {
      clientId: env.CONTABO_CLIENT_ID,
      clientSecret: env.CONTABO_CLIENT_SECRET,
      username: env.CONTABO_API_USER,
      password: env.CONTABO_API_PASSWORD,
    },
  };
  if (new URL(config.appUrl).pathname !== '/') throw new Error('APP_URL muss eine eigene Domain ohne Unterpfad sein');
  if (!config.dynDomain.endsWith(`.${config.zone}`)) throw new Error('DYNDNS_DOMAIN muss unterhalb von DNS_ZONE liegen');
  if (config.sessionSecret.length < 48) throw new Error('SESSION_SECRET benötigt mindestens 48 zufällige Zeichen');
  if (!['contabo', 'mock'].includes(config.provider)) throw new Error('DNS_PROVIDER muss contabo oder mock sein');
  if (production && (config.devAuth || config.provider === 'mock')) throw new Error('Entwicklungszugang und Mock-DNS sind in Produktion verboten');
  if (config.devAuth && (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.appUrl).hostname) || config.host !== '127.0.0.1')) {
    throw new Error('DEV_AUTH ist ausschließlich lokal auf 127.0.0.1 erlaubt');
  }
  if (!config.devAuth && !config.clientSecret) throw new Error('OIDC_CLIENT_SECRET fehlt');
  if (config.provider === 'contabo' && Object.values(config.contabo).some(value => !value)) throw new Error('Contabo-API-Konfiguration unvollständig');
  return config;
}
