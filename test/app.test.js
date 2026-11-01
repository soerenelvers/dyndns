import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, csrf, tokenFrom, basic, login } from './helpers.js';
import { identity } from '../src/auth.js';

test('complete host lifecycle: create, dual-stack update, no change, rotate, pause, resume', async t => {
  const f = await fixture(t);
  const browser = f.browser();
  const antiCsrf = await login(browser);
  const created = await browser('/hosts', { form: { csrf: antiCsrf, label: 'zuhause' } });
  assert.equal(created.status, 200);
  let token = tokenFrom(created.text);
  assert.equal(token.length, 43);
  const hostname = 'zuhause.dyn.example.com';
  const host = f.db.prepare('SELECT * FROM hosts').get();
  assert.notEqual(host.token_hash, token);
  assert.equal(host.token_hash.length, 64);
  const update = async (password = token, query = 'myip=8.8.8.8&myipv6=2606:4700:4700::1111') => {
    const response = await fetch(`${f.url}/nic/update?hostname=${hostname}&${query}`, { headers: { Authorization: basic(hostname, password) } });
    return { status: response.status, text: await response.text() };
  };
  assert.deepEqual(await update(), { status: 200, text: 'good 8.8.8.8,2606:4700:4700::1111\n' });
  assert.equal((await f.provider.list()).length, 2);
  assert.deepEqual(await update(), { status: 200, text: 'nochg 8.8.8.8,2606:4700:4700::1111\n' });
  const overview = await browser('/');
  assert.match(overview.text, /8\.8\.8\.8/);
  assert.match(overview.text, /2606:4700/);
  assert.ok(!overview.text.includes(token));
  const rotated = await browser(`/hosts/${host.id}/rotate`, { form: { csrf: antiCsrf } });
  assert.equal(rotated.status, 200);
  const oldToken = token;
  token = tokenFrom(rotated.text);
  assert.notEqual(token, oldToken);
  assert.equal((await update(oldToken)).status, 401);
  assert.equal((await update()).status, 200);
  assert.equal((await browser(`/hosts/${host.id}/toggle`, { form: { csrf: antiCsrf } })).status, 302);
  assert.equal((await update()).status, 401);
  assert.equal((await f.provider.list()).length, 2);
  await browser(`/hosts/${host.id}/toggle`, { form: { csrf: antiCsrf } });
  assert.equal((await update(token, 'myip=1.1.1.1')).text, 'good 1.1.1.1\n');
  await browser('/auth/logout', { form: { csrf: antiCsrf } });
  assert.match((await browser('/')).text, /Lokales Testkonto öffnen/);
});

test('requests require authorization, owner scope, CSRF, and valid host labels', async t => {
  const f = await fixture(t);
  const browser = f.browser();
  const page = await browser('/');
  assert.equal(page.response.headers.get('referrer-policy'), 'same-origin', 'native browser POSTs must retain their same-origin Origin header');
  assert.equal((await browser('/hosts', { form: { label: 'hack' } })).status, 403);
  assert.equal((await browser('/hosts', { form: { label: 'hack', csrf: csrf(page.text) } })).status, 401);
  const antiCsrf = await login(browser);
  assert.equal((await browser('/hosts', { headers: { Origin: f.config.appUrl }, form: { csrf: antiCsrf, label: 'browser-form' } })).status, 200);
  for (const label of ['a.b', '-bad', 'UPPER', '<script>', 'x'.repeat(64)]) {
    assert.equal((await browser('/hosts', { form: { csrf: antiCsrf, label } })).status, 400);
  }
  assert.equal((await browser('/hosts', { form: { csrf: 'ä'.repeat(64), label: 'home' } })).status, 403);
  assert.equal((await browser('/hosts', { headers: { Origin: 'https://evil.test' }, form: { csrf: antiCsrf, label: 'home' } })).status, 403);
  const created = await browser('/hosts', { form: { csrf: antiCsrf, label: 'home' } });
  assert.equal(created.status, 200);
  assert.equal((await browser('/hosts', { form: { csrf: antiCsrf, label: 'home' } })).status, 409);
  f.db.prepare('UPDATE hosts SET owner = ?').run(identity({ iss: 'local-development', sub: 'someone-else' }));
  assert.doesNotMatch((await browser('/')).text, /home\.dyn\.example\.com/);
  for (const action of ['rotate', 'toggle']) assert.equal((await browser(`/hosts/1/${action}`, { form: { csrf: antiCsrf } })).status, 404);
  const denied = await fetch(`${f.url}/nic/update?hostname=home.dyn.example.com&myip=8.8.8.8`);
  assert.equal(denied.status, 401);
  assert.equal(await denied.text(), 'badauth\n');
});

test('update validation does not call DNS; source IP is accepted only through a trusted local proxy', async t => {
  const f = await fixture(t);
  const browser = f.browser();
  const antiCsrf = await login(browser);
  const page = await browser('/hosts', { form: { csrf: antiCsrf, label: 'home' } });
  const hostname = 'home.dyn.example.com';
  const headers = { Authorization: basic(hostname, tokenFrom(page.text)) };
  for (const query of ['myip=127.0.0.1', 'myip=192.168.1.2', 'myip=::1', 'myip=169.254.1.1', 'myip=8.8.8.8&myip=1.1.1.1', 'myipv6=8.8.8.8']) {
    const response = await fetch(`${f.url}/nic/update?hostname=${hostname}&${query}`, { headers });
    assert.equal(response.status, 400, query);
  }
  assert.equal((await f.provider.list()).length, 0);
  const response = await fetch(`${f.url}/nic/update?hostname=${hostname}`, { headers: { ...headers, 'X-Forwarded-For': '8.8.4.4' } });
  assert.equal(await response.text(), 'good 8.8.4.4\n');
});

test('host quota is enforced and provider failures return protocol errors without reporting success', async t => {
  const f = await fixture(t, { env: { MAX_HOSTS_PER_USER: '1' } });
  const browser = f.browser();
  const antiCsrf = await login(browser);
  const page = await browser('/hosts', { form: { csrf: antiCsrf, label: 'one' } });
  assert.equal((await browser('/hosts', { form: { csrf: antiCsrf, label: 'two' } })).status, 409);
  f.provider.list = async () => { throw new Error('private provider response'); };
  const response = await fetch(`${f.url}/nic/update?hostname=one.dyn.example.com&myip=8.8.8.8`, {
    headers: { Authorization: basic('one.dyn.example.com', tokenFrom(page.text)) },
  });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '911\n');
  assert.equal(f.db.prepare('SELECT last_update FROM hosts').get().last_update, null);
});
