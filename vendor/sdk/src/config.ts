import { z } from 'zod';

/**
 * The runtime contract every micro-cloud app receives (set by the control
 * plane on deploy). Apps extend it with their own variables:
 *   const cfg = loadConfig({ GREETING: z.string().default('hi') });
 */
export const BaseConfig = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('app'),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_URL: z.url().default('http://localhost:8080'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  GIT_SHA: z.string().default('local'),
  DATABASE_URL: z.string().optional(),
  /** Platform auth service (token issuer). */
  AUTH_ISSUER: z.url().optional(),
  /** This app's resource: <PUBLIC_URL>/mcp. Tokens must carry aud = this. */
  AUTH_AUDIENCE: z.url().optional(),
  BUCKET: z.string().optional(),
  /** Local only (ignored unless NODE_ENV=development): skip sign-in as DEV_USER. */
  DEV_AUTH: z.stringbool().default(false),
  DEV_USER: z.string().default('dev@localhost'),
});

export function loadConfig<E extends z.ZodRawShape = Record<never, never>>(
  extra?: E,
  source: Record<string, string | undefined> = process.env,
): z.infer<typeof BaseConfig> & z.infer<z.ZodObject<E>> {
  const schema = extra ? BaseConfig.extend(extra) : BaseConfig;
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  const cfg = parsed.data as z.infer<typeof BaseConfig> & z.infer<z.ZodObject<E>>;
  if (cfg.DEV_AUTH && cfg.NODE_ENV !== 'development') cfg.DEV_AUTH = false;
  return cfg;
}
export type AppConfig = z.infer<typeof BaseConfig>;
