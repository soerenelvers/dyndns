import { randomUUID } from 'node:crypto';

export class ProviderError extends Error {
  constructor(message = 'DNS-Anbieter vorübergehend nicht erreichbar') { super(message); }
}

// Contract: Contabo/cntb openapi/api/openapi.yaml, DNS API v1.
export class ContaboDns {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetch = fetcher;
  }
  async token() {
    if (this.cached && this.cached.expires > Date.now() + 30000) return this.cached.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = (async () => {
      const response = await this.fetch('https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ grant_type: 'password', client_id: this.config.clientId,
          client_secret: this.config.clientSecret, username: this.config.username, password: this.config.password }),
      });
      if (!response.ok) throw new ProviderError('Contabo-Anmeldung fehlgeschlagen');
      const data = await response.json();
      if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new ProviderError();
      this.cached = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
      return this.cached.value;
    })().finally(() => { this.pendingToken = null; });
    return this.pendingToken;
  }
  async request(path, method = 'GET', body) {
    try {
      const response = await this.fetch(`https://api.contabo.com/v1/dns/zones/${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${await this.token()}`, 'x-request-id': randomUUID(), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) this.cached = null;
      // Never replay mutations after an ambiguous failure or timeout.
      if (!response.ok) throw new ProviderError();
      const data = await response.json();
      if (!Array.isArray(data.data)) throw new ProviderError();
      return data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError();
    }
  }
  async list(zone) {
    const records = [];
    for (let page = 1; page <= 1000; page++) {
      const result = await this.request(`${encodeURIComponent(zone)}/records?page=${page}&size=100`);
      records.push(...result.data);
      const pages = result._pagination?.totalPages;
      if (Number.isInteger(pages) ? page >= pages : result.data.length < 100) return records;
    }
    throw new ProviderError('DNS-Zone überschreitet das unterstützte Seitenlimit');
  }
  async create(zone, record) {
    const result = await this.request(`${encodeURIComponent(zone)}/records`, 'POST', { ...record, prio: 0 });
    const id = result.data[0]?.recordId;
    if (!Number.isSafeInteger(id) || id < 1) throw new ProviderError();
    return String(id);
  }
  async update(zone, id, record) {
    const { type, ttl, data } = record;
    await this.request(`${encodeURIComponent(zone)}/records/${encodeURIComponent(id)}`, 'PATCH', { type, ttl, data, prio: 0 });
  }
}

export class MockDns {
  constructor(db) { this.db = db; }
  async list() {
    return this.db.prepare('SELECT id AS recordId, name, type, ttl, data FROM mock_dns').all();
  }
  async create(zone, record) {
    return String(this.db.prepare('INSERT INTO mock_dns (name, type, ttl, data) VALUES (?, ?, ?, ?)')
      .run(record.name, record.type, record.ttl, record.data).lastInsertRowid);
  }
  async update(zone, id, record) {
    if (!this.db.prepare('UPDATE mock_dns SET data = ?, ttl = ? WHERE id = ?').run(record.data, record.ttl, id).changes) throw new ProviderError();
  }
}
