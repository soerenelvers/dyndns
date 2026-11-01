import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { ProviderError } from './dns.js';

export const hashToken = token => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function credentials(header) {
  if (typeof header !== 'string' || header.length > 1024 || !/^Basic [A-Za-z0-9+/]+=*$/i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 1) return null;
  return { username: decoded.slice(0, split), token: decoded.slice(split + 1) };
}

export function matchesToken(token, hash) {
  return timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(hash, 'hex'));
}

export function publicAddress(value) {
  if (typeof value !== 'string' || value.includes('%') || value.length > 45) throw new Error('Ungültige IP-Adresse');
  // Reject alternate IPv4 spellings and normalize IPv6, including mapped IPv4.
  if (value.includes('.') && !value.includes(':') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) throw new Error('Ungültige IP-Adresse');
  if (!ipaddr.isValid(value)) throw new Error('Ungültige IP-Adresse');
  const ip = ipaddr.process(value);
  if (!value.includes(':') && value !== ip.toString()) throw new Error('IPv4 muss dezimal und ohne führende Nullen angegeben werden');
  if (ip.range() !== 'unicast') throw new Error('Nur öffentliche IP-Adressen sind erlaubt');
  return { type: ip.kind() === 'ipv4' ? 'A' : 'AAAA', address: ip.toString() };
}

export function addresses(query, source) {
  const result = [];
  for (const field of ['myip', 'myipv6']) {
    if (query[field] !== undefined && query[field] !== '') {
      const ip = publicAddress(query[field]);
      if (field === 'myipv6' && ip.type !== 'AAAA') throw new Error('myipv6 benötigt IPv6');
      if (result.some(other => other.type === ip.type)) throw new Error('IP-Familie doppelt');
      result.push(ip);
    }
  }
  return result.length ? result : [publicAddress(source)];
}

export function createLock() {
  const pending = new Map();
  return async (key, action) => {
    const before = pending.get(key) || Promise.resolve();
    const current = before.catch(() => {}).then(action);
    pending.set(key, current);
    try { return await current; }
    finally { if (pending.get(key) === current) pending.delete(key); }
  };
}

function fqdn(name, zone) {
  const normalized = String(name).toLowerCase().replace(/\.$/, '');
  return normalized === zone || normalized.endsWith(`.${zone}`) ? normalized : `${normalized}.${zone}`;
}

export async function updateDns({ db, provider, config, host, ips }) {
  // Read the provider on every update: detect manual edits, deletion, and ID reuse.
  const records = (await provider.list(config.zone)).filter(record => fqdn(record.name, config.zone) === host.hostname);
  if (records.some(record => record.type === 'CNAME')) throw new ProviderError('Hostname hat bereits einen CNAME');
  let changed = false;
  for (const ip of ips) {
    const local = db.prepare('SELECT * FROM records WHERE host_id = ? AND type = ?').get(host.id, ip.type);
    const existing = records.filter(record => record.type === ip.type);
    if (existing.length > 1 || (existing.length && (!local || String(existing[0].recordId) !== local.provider_id))) {
      throw new ProviderError('Vorhandener DNS-Eintrag gehört nicht zu diesem Dienst');
    }
  }
  for (const ip of ips) {
    const existing = records.find(record => record.type === ip.type);
    const record = { name: host.hostname.slice(0, -(config.zone.length + 1)), type: ip.type, ttl: config.ttl, data: ip.address };
    let id;
    if (existing) {
      id = String(existing.recordId);
      if (existing.data !== ip.address || Number(existing.ttl) !== config.ttl) {
        await provider.update(config.zone, id, record);
        changed = true;
      }
    } else {
      id = await provider.create(config.zone, record);
      changed = true;
    }
    // Persist each successful family immediately; two-family updates are not atomic.
    db.prepare('INSERT OR REPLACE INTO records (host_id, type, provider_id, address) VALUES (?, ?, ?, ?)').run(host.id, ip.type, id, ip.address);
  }
  db.prepare('UPDATE hosts SET last_update = CURRENT_TIMESTAMP WHERE id = ?').run(host.id);
  return changed;
}
