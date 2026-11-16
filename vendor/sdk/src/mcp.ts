import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type PlatformTokenVerifier, platformTokenVerifier } from './auth';

export type McpUser = { email: string; clientId: string };

/**
 * Mounts an MCP endpoint at /mcp, protected by platform tokens:
 *  - /.well-known/oauth-protected-resource(/mcp) names the platform auth
 *    service, which is how Claude finds where to sign in;
 *  - every request needs a token issued by the platform FOR THIS APP
 *    (aud = resource), else 401 with WWW-Authenticate;
 *  - stateless Streamable HTTP: a fresh server per request, JSON responses.
 */
export function mountMcp(
  app: Hono,
  opts: {
    /** AUTH_AUDIENCE: <PUBLIC_URL>/mcp */
    resource: string;
    /** AUTH_ISSUER */
    issuer: string;
    name: string;
    version?: string;
    /** Scope advertised to clients; the platform uses the app name. */
    scope?: string;
    instructions?: string;
    /** Extra allowlist on top of the platform's (optional). */
    allowedEmails?: string[];
    /** Registers tools/resources/prompts for this caller. */
    register: (server: McpServer, user: McpUser) => void;
    /** Injected verifier (tests). */
    verify?: PlatformTokenVerifier;
  },
) {
  const resource = opts.resource.replace(/\/$/, '');
  const origin = new URL(resource).origin;
  const scope = opts.scope ?? opts.name;
  const verify = opts.verify ?? platformTokenVerifier({ issuer: opts.issuer, audience: resource });
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const prm = {
    resource,
    authorization_servers: [opts.issuer.replace(/\/$/, '')],
    scopes_supported: [scope],
    bearer_methods_supported: ['header'],
    resource_name: opts.name,
  };

  const mcpCors = cors({
    origin: '*',
    allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id'],
    exposeHeaders: ['www-authenticate', 'mcp-session-id', 'mcp-protocol-version'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });
  app.use('/mcp', mcpCors);
  app.use('/.well-known/oauth-protected-resource/*', mcpCors);
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(prm));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(prm));

  app.all('/mcp', async (c) => {
    const deny = (description?: string) => {
      c.header(
        'www-authenticate',
        `Bearer resource_metadata="${metadataUrl}", scope="${scope}"${
          description ? `, error="invalid_token", error_description="${description}"` : ''
        }`,
      );
      return c.json(
        { error: 'invalid_token', error_description: description ?? 'Authorization required' },
        401,
      );
    };
    const [scheme, token] = (c.req.header('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return deny();
    const claims = await verify(token).catch(() => null);
    if (!claims) return deny('Token is invalid or expired');
    const email = claims.email.toLowerCase();
    if (opts.allowedEmails && !opts.allowedEmails.includes(email))
      return deny('Account is not allowed');

    const server = new McpServer(
      { name: opts.name, version: opts.version ?? '1.0.0' },
      opts.instructions ? { instructions: opts.instructions } : undefined,
    );
    opts.register(server, { email, clientId: claims.client_id });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, {
        authInfo: {
          token,
          clientId: claims.client_id,
          scopes: claims.scope.split(' ').filter(Boolean),
          expiresAt: claims.exp,
          extra: { email },
        },
      });
    } finally {
      void transport.close();
      void server.close();
    }
  });
}
