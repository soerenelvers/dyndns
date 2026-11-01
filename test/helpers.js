import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { MockDns } from '../src/dns.js';
import { createApp } from '../src/app.js';

export async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dyndns-test-'));
  const config = loadConfig({ SESSION_SECRET: 's'.repeat(64), DEV_AUTH: 'true', DNS_PROVIDER: 'mock', DATA_DIR: dir, ...options.env });
  const db = openDatabase(dir);
  const provider = options.provider || new MockDns(db);
  const app = createApp({ config, db, provider, auth: options.auth?.(config) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function browser() {
    let cookie = '';
    return async (path, { form, ...init } = {}) => {
      const response = await fetch(`${url}${path}`, { redirect: 'manual', ...init,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
        ...(form ? { method: 'POST', body: new URLSearchParams(form) } : {}),
      });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await response.text();
      return { response, text, status: response.status };
    };
  }
  return { config, db, app, provider, url, browser };
}

export const csrf = text => text.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
export const tokenFrom = text => text.match(/class="secret">([A-Za-z0-9_-]+)</)?.[1];
export const basic = (hostname, token) => `Basic ${Buffer.from(`${hostname}:${token}`).toString('base64')}`;

export async function login(browser) {
  const page = await browser('/');
  const result = await browser('/auth/dev', { form: { csrf: csrf(page.text) } });
  if (result.status !== 302) throw new Error(`Login failed: ${result.status}`);
  return csrf((await browser('/')).text);
}
