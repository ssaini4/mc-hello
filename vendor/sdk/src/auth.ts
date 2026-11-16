/**
 * Verifies access tokens issued by the micro-cloud platform auth service.
 *
 * Every app checks three things: the signature (against the platform's
 * published JWKS, cached and refreshed on unknown `kid`), `iss` = the platform
 * issuer, and `aud` = this app's own resource URL. The audience check is what
 * stops a token minted for one app from working against another.
 */
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';

export type PlatformClaims = JWTPayload & {
  email: string;
  client_id: string;
  scope: string;
};

export type PlatformTokenVerifier = (token: string) => Promise<PlatformClaims>;

export function platformTokenVerifier(opts: {
  /** The platform auth service URL (AUTH_ISSUER), e.g. https://platform-auth-….run.app */
  issuer: string;
  /** This app's resource identifier (AUTH_AUDIENCE), e.g. https://myapp-api-….run.app/mcp */
  audience: string;
  /** Injected key source (tests); defaults to the issuer's /oauth/jwks.json. */
  keys?: JWTVerifyGetKey;
}): PlatformTokenVerifier {
  const issuer = opts.issuer.replace(/\/$/, '');
  const keys = opts.keys ?? createRemoteJWKSet(new URL(`${issuer}/oauth/jwks.json`));
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: opts.audience,
      typ: 'at+jwt',
      algorithms: ['ES256'],
    });
    if (typeof payload.email !== 'string' || typeof payload.client_id !== 'string')
      throw new Error('token is missing email or client_id');
    return {
      ...payload,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
    } as PlatformClaims;
  };
}
