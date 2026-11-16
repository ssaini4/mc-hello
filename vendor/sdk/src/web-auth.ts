import { createHash, randomBytes } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { type PlatformTokenVerifier, platformTokenVerifier } from './auth';

export type WebUser = { email: string };

const b64url = (b: Buffer) => b.toString('base64url');
const AT = 'mc_at';
const RT = 'mc_rt';
const CID = 'mc_cid';
const FLOW = 'mc_oauth';

/**
 * Sign-in for an app's web pages through the platform auth service (OAuth
 * 2.1 code + PKCE, the app as a public client registered on first use).
 * The platform access token (aud = this app) lives in an HttpOnly cookie and
 * is verified on every request; it's refreshed silently from the refresh
 * token. No app secret is needed.
 *
 *   const auth = webAuth(app, { publicUrl, issuer, resource, appName });
 *   app.get('/', auth.requireUser, (c) => c.text(`hi ${auth.user(c).email}`));
 */
export function webAuth(
  app: Hono,
  opts: {
    publicUrl: string;
    issuer: string;
    /** AUTH_AUDIENCE: tokens are requested for (and verified against) this resource. */
    resource: string;
    appName: string;
    /** Local development: every request is this user, no sign-in. */
    devUser?: string | null;
    verify?: PlatformTokenVerifier;
    fetchImpl?: typeof fetch;
  },
) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const issuer = opts.issuer.replace(/\/$/, '');
  const base = opts.publicUrl.replace(/\/$/, '');
  const redirectUri = `${base}/auth/callback`;
  const secure = base.startsWith('https://');
  const verify = opts.verify ?? platformTokenVerifier({ issuer, audience: opts.resource });
  let clientId: Promise<string> | null = null;

  const register = () => {
    clientId ??= (async () => {
      const r = await fetchImpl(`${issuer}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: opts.appName,
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
        }),
      });
      if (!r.ok) {
        clientId = null;
        throw new Error(`client registration failed: ${r.status} ${await r.text()}`);
      }
      return ((await r.json()) as { client_id: string }).client_id;
    })();
    return clientId;
  };

  const cookie = (c: Context, name: string, value: string, maxAge: number, path = '/') =>
    setCookie(c, name, value, { httpOnly: true, secure, sameSite: 'Lax', path, maxAge });

  async function tokenRequest(form: Record<string, string>) {
    const r = await fetchImpl(`${issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    if (!r.ok) return null;
    return (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  }

  function storeTokens(
    c: Context,
    t: { access_token: string; refresh_token?: string; expires_in: number },
    cid: string,
  ) {
    cookie(c, AT, t.access_token, Math.max(60, t.expires_in - 30));
    if (t.refresh_token) cookie(c, RT, t.refresh_token, 30 * 86_400);
    cookie(c, CID, cid, 30 * 86_400);
  }

  const safeNext = (n: string | undefined) => (n?.startsWith('/') && !n.startsWith('//') ? n : '/');

  app.get('/auth/login', async (c) => {
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    cookie(
      c,
      FLOW,
      JSON.stringify({ state, verifier, next: safeNext(c.req.query('next')) }),
      600,
      '/auth',
    );
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: await register(),
      redirect_uri: redirectUri,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
      scope: opts.appName,
      resource: opts.resource,
    });
    return c.redirect(`${issuer}/oauth/authorize?${q}`, 302);
  });

  app.get('/auth/callback', async (c) => {
    const flow = (() => {
      try {
        return JSON.parse(getCookie(c, FLOW) ?? '') as {
          state: string;
          verifier: string;
          next: string;
        };
      } catch {
        return null;
      }
    })();
    deleteCookie(c, FLOW, { path: '/auth' });
    const q = c.req.query();
    if (!flow || q.state !== flow.state)
      return c.text('Sign-in expired or invalid. Try again.', 400);
    if (q.iss && q.iss !== issuer) return c.text('Unexpected issuer.', 400); // RFC 9207
    if (q.error || !q.code)
      return c.text(`Sign-in failed: ${q.error_description ?? q.error ?? 'no code'}`, 400);
    const cid = await register();
    const t = await tokenRequest({
      grant_type: 'authorization_code',
      code: q.code,
      client_id: cid,
      redirect_uri: redirectUri,
      code_verifier: flow.verifier,
      resource: opts.resource,
    });
    if (!t || !(await verify(t.access_token).catch(() => null)))
      return c.text('Sign-in failed.', 400);
    storeTokens(c, t, cid);
    return c.redirect(flow.next, 302);
  });

  app.get('/auth/logout', async (c) => {
    const rt = getCookie(c, RT);
    const cid = getCookie(c, CID);
    if (rt && cid)
      await fetchImpl(`${issuer}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rt, client_id: cid }).toString(),
      }).catch(() => {});
    for (const n of [AT, RT, CID]) deleteCookie(c, n, { path: '/' });
    return c.redirect('/', 302);
  });

  const requireUser: MiddlewareHandler = async (c, next) => {
    if (opts.devUser) {
      c.set('mcUser' as never, { email: opts.devUser } as never);
      return next();
    }
    const at = getCookie(c, AT);
    let claims = at ? await verify(at).catch(() => null) : null;
    if (!claims) {
      const rt = getCookie(c, RT);
      const cid = getCookie(c, CID);
      if (rt && cid) {
        const t = await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: rt,
          client_id: cid,
        });
        if (t) {
          claims = await verify(t.access_token).catch(() => null);
          if (claims) storeTokens(c, t, cid);
        }
      }
    }
    if (!claims) {
      if (c.req.method === 'GET' && (c.req.header('accept') ?? '').includes('text/html')) {
        const u = new URL(c.req.url);
        return c.redirect(`/auth/login?next=${encodeURIComponent(u.pathname + u.search)}`, 302);
      }
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('mcUser' as never, { email: claims.email.toLowerCase() } as never);
    return next();
  };

  return {
    requireUser,
    user: (c: Context): WebUser => c.get('mcUser' as never) as WebUser,
  };
}
