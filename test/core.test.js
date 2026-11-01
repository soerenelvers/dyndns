import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { publicAddress, addresses, updateDns, createLock } from '../src/updates.js';
import { fixture, login, tokenFrom, basic } from './helpers.js';
import { ContaboDns } from '../src/dns.js';

test('production refuses unsafe development configuration and missing secrets', () => {
  const env = { SESSION_SECRET: 's'.repeat(64), DNS_PROVIDER: 'mock', DEV_AUTH: 'true' };
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production', APP_URL: 'https://dns.example.com' }));
  assert.throws(() => loadConfig({ ...env, SESSION_SECRET: 'short' }));
  assert.throws(() => loadConfig({ ...env, DYNDNS_DOMAIN: 'evil.com' }));
  assert.throws(() => loadConfig({ ...env, APP_URL: 'https://public.example.com' }));
  assert.throws(() => loadConfig({ ...env, APP_URL: 'http://localhost:3000/path' }));
  assert.throws(() => loadConfig({ ...env, DNS_TTL: '1' }));
});

test('public IP checks reject local, reserved, multicast, and ambiguous addresses', () => {
  for (const value of ['10.0.0.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', '127.0.0.1', '0.0.0.0', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '8.8.8.008', '0x08080808', '8.8.8.8/32', '8.8.8.8%eth0']) {
    assert.throws(() => publicAddress(value), value);
  }
  assert.deepEqual(publicAddress('::ffff:8.8.8.8'), { type: 'A', address: '8.8.8.8' });
  assert.deepEqual(publicAddress('2606:4700:4700:0:0:0:0:1111'), { type: 'AAAA', address: '2606:4700:4700::1111' });
  assert.throws(() => addresses({ myip: '2606:4700::1111', myipv6: '2606:4700::1001' }));
});

test('existing unmanaged DNS is never adopted; renamed provider IDs are never changed', async t => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO hosts (owner, hostname, token_hash) VALUES ('owner', 'home.dyn.example.com', 'hash')").run();
  const host = f.db.prepare('SELECT * FROM hosts').get();
  const args = { ...f, host, ips: [{ type: 'A', address: '8.8.8.8' }] };
  const id = await f.provider.create('example.com', { name: 'home.dyn', type: 'A', data: '1.1.1.1', ttl: 300 });
  await assert.rejects(updateDns(args), /gehört nicht/);
  assert.equal((await f.provider.list())[0].data, '1.1.1.1');
  f.db.prepare('DELETE FROM mock_dns').run();
  assert.equal(await updateDns(args), true);
  const record = f.db.prepare('SELECT * FROM records').get();
  assert.notEqual(record.provider_id, undefined);
  f.db.prepare("UPDATE mock_dns SET name = 'unrelated'").run();
  assert.equal(await updateDns(args), true);
  const unrelated = (await f.provider.list()).find(row => row.name === 'unrelated');
  assert.equal(unrelated.data, '8.8.8.8');
  assert.equal((await f.provider.list()).length, 2);
  assert.ok(id);
});

test('concurrent updates create a single provider record, and failed locks recover', async t => {
  const f = await fixture(t);
  const browser = f.browser();
  const antiCsrf = await login(browser);
  const page = await browser('/hosts', { form: { csrf: antiCsrf, label: 'home' } });
  const hostname = 'home.dyn.example.com';
  const results = await Promise.all(Array.from({ length: 5 }, () => fetch(`${f.url}/nic/update?hostname=${hostname}&myip=8.8.8.8`, {
    headers: { Authorization: basic(hostname, tokenFrom(page.text)) },
  }).then(response => response.text())));
  assert.equal(results.filter(text => text.startsWith('good')).length, 1);
  assert.equal(results.filter(text => text.startsWith('nochg')).length, 4);
  assert.equal((await f.provider.list()).length, 1);
  const lock = createLock();
  await assert.rejects(lock('key', () => { throw new Error('failure'); }));
  assert.equal(await lock('key', () => 42), 42);
});

test('Contabo wire contract: authentication, pagination, relative names, PATCH body and request IDs', async () => {
  const calls = [];
  const provider = new ContaboDns({ clientId: 'id', clientSecret: 'secret', username: 'user', password: 'password' }, async (url, init) => {
    calls.push({ url, ...init });
    if (url.includes('auth.contabo.com')) {
      assert.equal(init.body.get('grant_type'), 'password');
      assert.equal(init.body.get('username'), 'user');
      return Response.json({ access_token: 'test-token', expires_in: 300 });
    }
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.match(init.headers['x-request-id'], /^[a-f0-9-]{36}$/);
    if (init.method === 'GET') return Response.json({ data: [{ recordId: calls.length }], _pagination: { totalPages: 2 } });
    return Response.json({ data: [{ recordId: 123 }] });
  });
  assert.equal((await provider.list('example.com')).length, 2);
  assert.equal(await provider.create('example.com', { name: 'home.dyn', type: 'A', ttl: 300, data: '8.8.8.8' }), '123');
  await provider.update('example.com', '123', { name: 'home.dyn', type: 'A', ttl: 300, data: '1.1.1.1' });
  assert.equal(calls.filter(call => call.url.includes('auth.contabo')).length, 1);
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.equal(calls.at(-1).url, 'https://api.contabo.com/v1/dns/zones/example.com/records/123');
  assert.deepEqual(JSON.parse(calls.at(-1).body), { type: 'A', ttl: 300, data: '1.1.1.1', prio: 0 });
  assert.equal(JSON.parse(calls.at(-2).body).name, 'home.dyn');
});

test('Contabo auth and mutation failures do not expose secrets or replay writes', async () => {
  let writes = 0;
  const provider = new ContaboDns({}, async (url, init) => {
    if (url.includes('auth.contabo')) return Response.json({ access_token: 'sensitive', expires_in: 300 });
    writes++;
    return new Response('sensitive provider body', { status: 500 });
  });
  await assert.rejects(provider.create('example.com', { name: 'test' }), error => !error.message.includes('sensitive'));
  assert.equal(writes, 1);
});
