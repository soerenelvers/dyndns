import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SqliteSessionStore } from './db.js';
import { createAuth, AuthError, identity } from './auth.js';
import { addresses, createLock, credentials, hashToken, matchesToken, newToken, updateDns } from './updates.js';
import { dashboard, errorPage, loginPage, tokenPage } from './views.js';

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

export function createApp({ config, db, provider, auth = createAuth(config) }) {
  const app = express();
  const lock = createLock();
  app.disable('x-powered-by');
  // Only the reverse proxy on this machine may supply forwarding headers.
  app.set('trust proxy', 'loopback');
  app.use(helmet({ strictTransportSecurity: config.production ? undefined : false,
    // no-referrer makes browser form POST origins opaque ("null"), failing CSRF validation.
    referrerPolicy: { policy: 'same-origin' },
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': config.production ? [] : null } } }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (config.production && !req.secure) return res.status(400).type('text').send('HTTPS erforderlich');
    next();
  });
  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', dnsProvider: config.provider });
  });
  app.get('/style.css', (req, res) => res.sendFile(fileURLToPath(new URL('../public/style.css', import.meta.url))));

  const updateLimit = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => res.status(429).type('text').send('911\n') });
  app.get('/nic/update', updateLimit, async (req, res) => {
    const reply = (status, text) => res.status(status).type('text').send(`${text}\n`);
    const login = credentials(req.get('authorization'));
    if (!login) { res.set('WWW-Authenticate', 'Basic realm="DynDNS", charset="UTF-8"'); return reply(401, 'badauth'); }
    if (typeof req.query.hostname !== 'string' || req.query.hostname.length > 253) return reply(400, 'notfqdn');
    const hostname = req.query.hostname.toLowerCase();
    if (login.username.toLowerCase() !== hostname) return reply(401, 'badauth');
    let ips;
    try { ips = addresses(req.query, req.ip); } catch { return reply(400, 'dnserr'); }
    // One process and a global mutation lock keep provisioning, rotation and updates ordered.
    return lock('mutations', async () => {
      const host = db.prepare('SELECT * FROM hosts WHERE hostname = ?').get(hostname);
      if (!host || !host.enabled || !matchesToken(login.token, host.token_hash)) return reply(401, 'badauth');
      try {
        const changed = await updateDns({ db, provider, config, host, ips });
        return reply(200, `${changed ? 'good' : 'nochg'} ${ips.map(ip => ip.address).join(',')}`);
      } catch {
        // Provider response bodies may contain customer information: never log them.
        return reply(503, '911');
      }
    });
  });

  app.use(session({ name: 'dyndns.sid', secret: config.sessionSecret, store: new SqliteSessionStore(db),
    resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: config.production,
      sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } }));
  app.use(express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 10 }));
  app.use((req, res, next) => {
    req.session.csrf ||= randomBytes(32).toString('hex');
    if (req.method === 'POST') {
      const token = req.body?.csrf;
      const origin = req.get('origin');
      if ((origin && origin !== new URL(config.appUrl).origin) || typeof token !== 'string' ||
          !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) {
        return next(httpError(403, 'Ungültige Formularanfrage. Seite neu laden.'));
      }
    }
    next();
  });
  const browserLimit = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: 'Zu viele Anfragen. Bitte kurz warten.' });
  app.use(browserLimit);
  app.get('/auth/login', auth.login);
  app.get('/auth/callback', auth.callback);
  if (config.devAuth) app.post('/auth/dev', auth.devLogin);
  app.post('/auth/logout', (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('dyndns.sid', { httpOnly: true, secure: config.production, sameSite: 'lax' });
      res.redirect('/');
    });
  });
  app.get('/', async (req, res) => {
    if (!req.session.user) return res.send(loginPage(config, req.session.csrf));
    const access = await auth.access(req, 'dyndns.read');
    const hosts = db.prepare('SELECT * FROM hosts WHERE owner = ? ORDER BY hostname').all(identity(req.session.user));
    const records = db.prepare('SELECT r.* FROM records r JOIN hosts h ON h.id = r.host_id WHERE h.owner = ?').all(identity(req.session.user));
    res.send(dashboard(config, req.session.user, req.session.csrf, hosts, records, access.permissions.includes('dyndns.write')));
  });
  app.post('/hosts', async (req, res) => {
    await auth.access(req, 'dyndns.write');
    const label = req.body.label;
    if (typeof label !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) throw httpError(400, 'Name muss aus Kleinbuchstaben, Ziffern und inneren Bindestrichen bestehen.');
    const hostname = `${label}.${config.dynDomain}`;
    if (hostname.length > 253 || hostname === new URL(config.appUrl).hostname) throw httpError(400, 'Dieser Hostname ist nicht verfügbar.');
    await lock('mutations', async () => {
      const owner = identity(req.session.user);
      const count = db.prepare('SELECT COUNT(*) AS count FROM hosts WHERE owner = ?').get(owner).count;
      if (count >= config.maxHosts) throw httpError(409, 'Maximale Anzahl von Hostnamen erreicht.');
      if (db.prepare('SELECT id FROM hosts WHERE hostname = ?').get(hostname)) throw httpError(409, 'Dieser Hostname ist bereits vergeben.');
      const token = newToken();
      db.prepare('INSERT INTO hosts (owner, hostname, token_hash) VALUES (?, ?, ?)').run(owner, hostname, hashToken(token));
      res.send(tokenPage(config, req.session.user, hostname, token));
    });
  });
  for (const action of ['rotate', 'toggle']) {
    app.post(`/hosts/:id/${action}`, async (req, res) => {
      await auth.access(req, 'dyndns.write');
      await lock('mutations', async () => {
        if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) throw httpError(404, 'Hostname nicht gefunden.');
        const host = db.prepare('SELECT * FROM hosts WHERE id = ? AND owner = ?').get(req.params.id, identity(req.session.user));
        if (!host) throw httpError(404, 'Hostname nicht gefunden.');
        if (action === 'toggle') {
          db.prepare('UPDATE hosts SET enabled = 1 - enabled WHERE id = ?').run(host.id);
          return res.redirect('/');
        }
        const token = newToken();
        db.prepare('UPDATE hosts SET token_hash = ? WHERE id = ?').run(hashToken(token), host.id);
        res.send(tokenPage(config, req.session.user, host.hostname, token));
      });
    });
  }
  app.use((req, res) => res.status(404).send(errorPage(404, 'Seite nicht gefunden.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof AuthError ? error.status : [400, 403, 404, 409, 413].includes(error.status) ? error.status : 503;
    if (error instanceof AuthError && status === 401) {
      req.session?.destroy(() => {});
      res.clearCookie('dyndns.sid', { httpOnly: true, secure: config.production, sameSite: 'lax' });
    }
    const message = error instanceof AuthError ? ({ 401: 'Bitte erneut anmelden.', 403: 'Keine Freigabe oder Berechtigung für diese Aktion.', 503: 'ZugangsWerk ist vorübergehend nicht erreichbar.' })[status]
      : status === 503 ? 'Der Dienst ist vorübergehend nicht verfügbar.' : error.message;
    res.status(status).send(errorPage(status, message));
  });
  return app;
}
