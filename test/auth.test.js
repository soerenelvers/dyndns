import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createAuth } from '../src/auth.js';
import { fixture, csrf } from './helpers.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
const issuer = 'https://identity.example.test/realm';

function jwt(claims) {
  const encoded = [ { alg: 'RS256', kid: 'test' }, claims ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`;
}

async function oidcFixture(t, overrides = {}) {
  const state = { accessStatus: 200, permissions: ['dyndns.read', 'dyndns.write'], refreshes: 0, accessCalls: 0, tokenCalls: 0 };
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/token')) {
      state.tokenCalls++;
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('client_id'), 'dyndns');
      assert.equal(params.get('client_secret'), 'test-client-secret');
      if (params.get('grant_type') === 'refresh_token') {
        state.refreshes++;
        assert.equal(params.get('refresh_token'), 'refresh-one');
        await new Promise(resolve => setTimeout(resolve, 20));
        if (state.rejectRefresh) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({ access_token: 'access-two', refresh_token: 'refresh-two', token_type: 'Bearer', expires_in: 300 });
      }
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('code'), 'valid');
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), state.challenge);
      const now = Math.floor(Date.now() / 1000);
      let idToken = jwt({ iss: issuer, aud: 'dyndns', sub: 'user-one', iat: now, exp: now + 300, nonce: state.nonce,
        preferred_username: '<script>alert(1)</script>', ...overrides });
      if (overrides.badSignature) idToken = `${idToken.slice(0, idToken.lastIndexOf('.') + 1)}${'a'.repeat(342)}`;
      return Response.json({ access_token: 'access-one', refresh_token: 'refresh-one', token_type: 'Bearer', expires_in: 300,
        id_token: idToken,
      });
    }
    if (url === 'https://accounts.example.test/api/access/dyndns') {
      state.accessCalls++;
      const authorization = new Headers(init.headers).get('authorization');
      assert.match(authorization, /^Bearer access-(one|two)$/);
      return Response.json({ clientId: 'dyndns', sub: state.wrongUser ? 'someone-else' : 'user-one', permissions: state.permissions }, { status: state.accessStatus });
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
  const f = await fixture(t, {
    env: { DEV_AUTH: 'false', OIDC_CLIENT_SECRET: 'test-client-secret', OIDC_ISSUER: issuer, ACCOUNTS_URL: 'https://accounts.example.test' },
    auth: config => createAuth(config, fetcher),
  });
  const browser = f.browser();
  async function begin() {
    await browser('/');
    const started = await browser('/auth/login');
    assert.equal(started.status, 302);
    const redirect = new URL(started.response.headers.get('location'));
    state.nonce = redirect.searchParams.get('nonce');
    state.challenge = redirect.searchParams.get('code_challenge');
    assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(state.nonce);
    return redirect.searchParams.get('state');
  }
  async function complete() {
    const loginState = await begin();
    return browser(`/auth/callback?code=valid&state=${encodeURIComponent(loginState)}`);
  }
  function expire() {
    const row = f.db.prepare("SELECT * FROM sessions WHERE data LIKE '%access-one%'").get();
    const data = JSON.parse(row.data);
    data.tokens.expires = Date.now() - 1000;
    f.db.prepare('UPDATE sessions SET data = ? WHERE sid = ?').run(JSON.stringify(data), row.sid);
  }
  return { ...f, browser, state, begin, complete, expire };
}

test('OIDC login validates a signed ID token and PKCE, escapes profile text, checks current access', async t => {
  const f = await oidcFixture(t);
  const result = await f.complete();
  assert.equal(result.status, 302);
  const page = await f.browser('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /&lt;script&gt;/);
  assert.doesNotMatch(page.text, /<script>/);
  assert.equal(f.state.accessCalls, 1);
  f.state.accessStatus = 403;
  assert.equal((await f.browser('/')).status, 403, 'revoked access is denied immediately');
  f.state.accessStatus = 503;
  assert.equal((await f.browser('/')).status, 503, 'outage fails closed');
  f.state.accessStatus = 200;
  f.state.wrongUser = true;
  assert.equal((await f.browser('/')).status, 403, 'access response must match session subject');
});

test('read-only permission prevents host mutations in the backend', async t => {
  const f = await oidcFixture(t);
  await f.complete();
  f.state.permissions = ['dyndns.read'];
  const page = await f.browser('/');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /action="\/hosts"/);
  assert.equal((await f.browser('/hosts', { form: { csrf: csrf(page.text), label: 'forbidden' } })).status, 403);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM hosts').get().count, 0);
});

test('OIDC rejects invalid state, nonce, audience, issuer, expiration, and replayed callback', async t => {
  for (const claims of [{ nonce: 'wrong' }, { aud: 'another-tool' }, { iss: 'https://evil.test' }, { exp: 1 }, { badSignature: true }]) {
    await t.test(JSON.stringify(claims), async t => {
      const f = await oidcFixture(t, claims);
      assert.notEqual((await f.complete()).status, 302);
      assert.match((await f.browser('/')).text, /Mit ZugangsWerk anmelden/);
    });
  }
  const f = await oidcFixture(t);
  await f.begin();
  assert.notEqual((await f.browser('/auth/callback?code=valid&state=wrong')).status, 302);
  assert.equal(f.state.tokenCalls, 0);
  assert.equal((await f.complete()).status, 302);
  assert.equal((await f.browser('/auth/callback?code=valid&state=replay')).status, 401);
});

test('concurrent requests refresh once and persist the rotated refresh token', async t => {
  const f = await oidcFixture(t);
  await f.complete();
  f.expire();
  const results = await Promise.all([f.browser('/'), f.browser('/'), f.browser('/')]);
  assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
  assert.equal(f.state.refreshes, 1);
  assert.equal(f.state.accessCalls, 3);
  const stored = f.db.prepare("SELECT data FROM sessions WHERE data LIKE '%access-two%'").get();
  assert.equal(JSON.parse(stored.data).tokens.refreshToken, 'refresh-two');
});

test('invalid refresh grant ends the local login', async t => {
  const f = await oidcFixture(t);
  await f.complete();
  f.expire();
  f.state.rejectRefresh = true;
  assert.equal((await f.browser('/')).status, 401);
  assert.match((await f.browser('/')).text, /Mit ZugangsWerk anmelden/);
});
