import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

export type Sql = postgres.Sql;

/**
 * postgres-js from DATABASE_URL. On Cloud Run the URL is the socket form
 * (postgres://role:pw@/db?host=/cloudsql/<connection>), which postgres-js
 * handles natively.
 */
export function createSql(url: string, opts: { max?: number; appName?: string } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 5,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { application_name: opts.appName ?? process.env.APP_NAME ?? 'app' },
    onnotice: () => {},
  });
}

/**
 * Applies <dir>/NNNN_name.sql files in order, once each, under an advisory
 * lock (safe if several instances start at once). Returns what it applied.
 */
export async function migrate(sql: Sql, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('micro-cloud-migrate'))`;
    await tx`create table if not exists app_migrations (
      name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set(
      (await tx<{ name: string }[]>`select name from app_migrations`).map((r) => r.name),
    );
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(await readFile(join(dir, f), 'utf8'));
      await tx`insert into app_migrations (name) values (${f})`;
      applied.push(f);
    }
  });
  return applied;
}
