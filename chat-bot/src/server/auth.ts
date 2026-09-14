// OpenID Connect login against Keycloak (auth code + PKCE). The chat bot never sees the password —
// it redirects to Keycloak, gets back a code, and holds the resulting token server-side.

import { createHash, randomBytes } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { config } from './config.js';

export interface UserSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  username: string;
  roles: string[];
}

declare module 'express-session' {
  interface SessionData {
    user?: UserSession;
    pkceVerifier?: string;
    oauthState?: string;
  }
}

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

let endpoints: Endpoints | undefined;

const swap = (url: string, from: string, to: string): string =>
  url.startsWith(from) ? to + url.slice(from.length) : url;

// Read from the realm's discovery document rather than hardcoding paths — it mixes public and
// in-network URLs, so split by caller: browser follows authorization_endpoint, we call the rest.
async function discover(): Promise<Endpoints> {
  if (endpoints) return endpoints;
  const { issuer, publicIssuer } = config.oidc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Endpoints;
  endpoints = {
    ...doc,
    authorization_endpoint: swap(doc.authorization_endpoint, issuer, publicIssuer),
    token_endpoint: swap(doc.token_endpoint, publicIssuer, issuer),
    end_session_endpoint:
      doc.end_session_endpoint && swap(doc.end_session_endpoint, publicIssuer, issuer),
  };
  return endpoints;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function claims(accessToken: string): { username: string; roles: string[]; exp: number } {
  const [, payload] = accessToken.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as {
    preferred_username?: string;
    sub?: string;
    exp?: number;
    roles?: string[];
    realm_access?: { roles?: string[] };
  };
  return {
    username: decoded.preferred_username ?? decoded.sub ?? 'unknown',
    roles: decoded.roles ?? decoded.realm_access?.roles ?? [],
    exp: decoded.exp ?? 0,
  };
}

async function exchange(body: Record<string, string>): Promise<UserSession> {
  const { token_endpoint } = await discover();
  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      ...body,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const { username, roles } = claims(token.access_token);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (token.expires_in ?? 300) * 1000,
    username,
    roles,
  };
}

// Returns the session's access token, refreshing it first if it is about to expire.
// `undefined` means the caller has to sign in again.
export async function validToken(req: Request): Promise<string | undefined> {
  const user = req.session.user;
  if (!user) return undefined;
  if (Date.now() < user.expiresAt - 30_000) return user.accessToken;
  if (!user.refreshToken) return undefined;
  try {
    req.session.user = await exchange({
      grant_type: 'refresh_token',
      refresh_token: user.refreshToken,
    });
    return req.session.user.accessToken;
  } catch {
    delete req.session.user;
    return undefined;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.authEnabled || req.session.user) {
    next();
    return;
  }
  res.status(401).json({ error: 'not signed in' });
}

export function registerAuthRoutes(app: Express, onSignOut: (sessionId: string) => void): void {
  app.get('/api/me', (req, res) => {
    if (!config.authEnabled) {
      res.json({ authEnabled: false, user: null, roles: [] });
      return;
    }
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ authEnabled: true, error: 'not signed in' });
      return;
    }
    res.json({ authEnabled: true, user: user.username, roles: user.roles });
  });

  app.get('/login', async (req, res) => {
    if (!config.authEnabled) {
      res.redirect('/');
      return;
    }
    try {
      const { authorization_endpoint } = await discover();
      const verifier = base64url(randomBytes(32));
      req.session.pkceVerifier = verifier;
      req.session.oauthState = base64url(randomBytes(16));
      const params = new URLSearchParams({
        client_id: config.oidc.clientId,
        redirect_uri: config.oidc.redirectUri,
        response_type: 'code',
        scope: config.oidc.scope,
        state: req.session.oauthState,
        code_challenge: base64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
      });
      req.session.save(() => res.redirect(`${authorization_endpoint}?${params}`));
    } catch (e) {
      res.status(502).send(`Cannot reach Keycloak: ${String(e)}`);
    }
  });

  app.get('/login/callback', async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const verifier = req.session.pkceVerifier;
    if (!code || !verifier || state !== req.session.oauthState) {
      res.status(400).send('Invalid login callback');
      return;
    }
    delete req.session.pkceVerifier;
    delete req.session.oauthState;
    try {
      req.session.user = await exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oidc.redirectUri,
        code_verifier: verifier,
      });
      // A new identity means a new MCP connection, not the previous user's.
      onSignOut(req.sessionID);
      req.session.save(() => res.redirect('/'));
    } catch (e) {
      res.status(401).send(`Login failed: ${String(e)}`);
    }
  });

  app.post('/logout', async (req, res) => {
    const refreshToken = req.session.user?.refreshToken;
    onSignOut(req.sessionID);
    if (refreshToken) {
      const { end_session_endpoint } = await discover().catch(() => ({}) as Endpoints);
      if (end_session_endpoint) {
        await fetch(end_session_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.oidc.clientId,
            client_secret: config.oidc.clientSecret,
            refresh_token: refreshToken,
          }).toString(),
        }).catch(() => undefined);
      }
    }
    req.session.destroy(() => res.json({ ok: true }));
  });
}
