import type { Hono } from 'hono';

/** /health (liveness, no dependencies) and /ready (runs `ping`). Not /healthz: Cloud Run intercepts it. */
export function healthRoutes(
  app: Hono,
  opts: { service: string; commit: string; ping?: () => Promise<unknown> },
) {
  app.get('/health', (c) => c.json({ status: 'ok', service: opts.service, commit: opts.commit }));
  app.get('/ready', async (c) => {
    try {
      await opts.ping?.();
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });
}
