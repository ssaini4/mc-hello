// Run by the deploy's migrate step (micro-cloud.json) before services roll out.
import { join } from 'node:path';
import { createSql, migrate } from '@micro-cloud/sdk/db';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const sql = createSql(url, { max: 1 });
const applied = await migrate(sql, join(import.meta.dir, '..', 'migrations'));
process.stdout.write(`${JSON.stringify({ severity: 'INFO', message: 'migrations', applied })}\n`);
await sql.end();
