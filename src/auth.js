import * as oidc from 'openid-client';
import { createLock } from './updates.js';

export function identity(user) { return JSON.stringify([user.iss, user.sub]); }
export const saveSession = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));

export class AuthError extends Error {
  constructor(status) { super('Zugriff nicht möglich'); this.status = status; }
}

export function createAuth(config, fetcher = fetch) {
  let discovery;
  const refreshLock = createLock();
  async function client() {
    if (!discovery) discovery = oidc.discovery(new URL(config.issuer), config.clientId,
      { client_secret: config.clientSecret, id_token_signed_response_alg: 'RS256' }, undefined,
      { [oidc.customFetch]: fetcher, timeout: 5, execute: [oidc.enableNonRepudiationChecks] })
      .catch(error => { discovery = null; throw error; });
    return discovery;
  }
  function tokensForSession(tokens) {
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expires: Date.now() + (tokens.expires_in ?? 300) * 1000 };
  }
  return {
    async login(req, res) {
      const provider = await client();
      await regenerate(req);
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      req.session.oauth = { state, nonce, verifier, created: Date.now() };
      await saveSession(req);
      const target = oidc.buildAuthorizationUrl(provider, {
        redirect_uri: `${config.appUrl}/auth/callback`, scope: 'openid profile email', state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
      res.redirect(target.toString());
    },
    async callback(req, res) {
      const flow = req.session.oauth;
      delete req.session.oauth;
      await saveSession(req);
      if (!flow || Date.now() - flow.created > 600000) throw new AuthError(401);
      const target = new URL(req.originalUrl, config.appUrl);
      const tokens = await oidc.authorizationCodeGrant(await client(), target, {
        pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub || claims.iss !== config.issuer) throw new AuthError(401);
      await regenerate(req);
      req.session.user = { sub: claims.sub, iss: claims.iss, name: claims.preferred_username || claims.name || 'Benutzer' };
      req.session.tokens = tokensForSession(tokens);
      await saveSession(req);
      res.redirect('/');
    },
    async devLogin(req, res) {
      await regenerate(req);
      req.session.user = { iss: 'local-development', sub: 'developer', name: 'Lokale Entwicklung' };
      await saveSession(req);
      res.redirect('/');
    },
    async access(req, permission) {
      if (!req.session.user) throw new AuthError(401);
      if (config.devAuth) return { permissions: ['dyndns.read', 'dyndns.write'] };
      return refreshLock(req.sessionID, async () => {
        // Reload under the lock: concurrent requests may hold an old refresh token.
        await new Promise((resolve, reject) => req.session.reload(error => error ? reject(new AuthError(401)) : resolve()));
        if (!req.session.user || !req.session.tokens) throw new AuthError(401);
        try {
          if (req.session.tokens.expires <= Date.now() + 30000) {
            const previous = req.session.tokens;
            if (!previous.refreshToken) throw new AuthError(401);
            const refreshed = await oidc.refreshTokenGrant(await client(), previous.refreshToken);
            const claims = refreshed.claims();
            if (claims && (claims.iss !== req.session.user.iss || claims.sub !== req.session.user.sub)) throw new AuthError(401);
            req.session.tokens = { ...tokensForSession(refreshed), refreshToken: refreshed.refresh_token || previous.refreshToken };
            await saveSession(req);
          }
          const response = await fetcher(`${config.accountsUrl}/api/access/${encodeURIComponent(config.clientId)}`, {
            headers: { Authorization: `Bearer ${req.session.tokens.accessToken}`, Accept: 'application/json' },
            redirect: 'error', signal: AbortSignal.timeout(5000),
          });
          if ([401, 403, 404].includes(response.status)) throw new AuthError(response.status === 404 ? 401 : response.status);
          if (!response.ok) throw new AuthError(503);
          const access = await response.json();
          if (access.sub !== req.session.user.sub || access.clientId !== config.clientId ||
              !Array.isArray(access.permissions) || !access.permissions.includes(permission)) throw new AuthError(403);
          return access;
        } catch (error) {
          if (error instanceof AuthError) throw error;
          if (error?.code === 'OAUTH_RESPONSE_BODY_ERROR' && error?.error === 'invalid_grant') throw new AuthError(401);
          throw new AuthError(503);
        }
      });
    },
  };
}
