/**
 * hello: a micro-cloud app. Platform sign-in for pages, an MCP endpoint for
 * Claude, Postgres for data, the app bucket for files.
 */
import { loadConfig } from '@micro-cloud/sdk/config';
import { createSql } from '@micro-cloud/sdk/db';
import { healthRoutes } from '@micro-cloud/sdk/health';
import { createLogger } from '@micro-cloud/sdk/log';
import { mountMcp } from '@micro-cloud/sdk/mcp';
import { bucketStore } from '@micro-cloud/sdk/storage';
import { webAuth } from '@micro-cloud/sdk/web-auth';
import { Hono } from 'hono';
import { z } from 'zod';

const cfg = loadConfig();
const log = createLogger({ level: cfg.LOG_LEVEL, base: { service: cfg.APP_NAME } });
const sql = cfg.DATABASE_URL ? createSql(cfg.DATABASE_URL) : null;
const bucket = bucketStore(cfg.BUCKET);
const issuer = cfg.AUTH_ISSUER ?? 'http://localhost:8090';
const resource = cfg.AUTH_AUDIENCE ?? `${cfg.PUBLIC_URL}/mcp`;

type Note = { id: string; author: string; body: string; created_at: Date };

async function listNotes(limit = 50): Promise<Note[]> {
  if (!sql) return [];
  return sql<
    Note[]
  >`select id, author, body, created_at from notes order by id desc limit ${limit}`;
}
async function addNote(author: string, body: string): Promise<Note> {
  if (!sql) throw new Error('no database configured');
  const [n] = await sql<
    Note[]
  >`insert into notes (author, body) values (${author}, ${body}) returning *`;
  if (!n) throw new Error('insert failed');
  // Also keep a copy in the app bucket.
  await bucket.put(
    `notes/${n.id}.txt`,
    `${n.author} @ ${n.created_at.toISOString()}\n\n${n.body}\n`,
  );
  log.info('note added', { id: n.id });
  return n;
}

const app = new Hono();
healthRoutes(app, {
  service: cfg.APP_NAME,
  commit: cfg.GIT_SHA,
  ping: async () => {
    if (sql) await sql`select 1`;
  },
});

const auth = webAuth(app, {
  publicUrl: cfg.PUBLIC_URL,
  issuer,
  resource,
  appName: cfg.APP_NAME,
  devUser: cfg.DEV_AUTH ? cfg.DEV_USER : null,
});

const Page = (p: { email: string; notes: Note[]; files: number }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{cfg.APP_NAME}</title>
      <style>{`body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}
li{margin:8px 0}small{color:#777}textarea{width:100%;min-height:80px}button{padding:8px 16px}`}</style>
    </head>
    <body>
      <h1>{cfg.APP_NAME}</h1>
      <p>
        Signed in as <b>{p.email}</b> · <a href="/auth/logout">sign out</a>
      </p>
      <form method="post" action="/notes">
        <textarea name="body" required maxlength={2000} placeholder="Write a note" />
        <button type="submit">Add note</button>
      </form>
      <p>
        <small>
          {p.notes.length} recent notes · {p.files} copies in the bucket
        </small>
      </p>
      <ul>
        {p.notes.map((n) => (
          <li>
            {n.body}{' '}
            <small>
              ({n.author}, {n.created_at.toISOString().slice(0, 16).replace('T', ' ')})
            </small>
          </li>
        ))}
      </ul>
    </body>
  </html>
);

app.get('/', auth.requireUser, async (c) => {
  const [notes, files] = await Promise.all([listNotes(), bucket.list('notes/')]);
  return c.html(<Page email={auth.user(c).email} notes={notes} files={files.length} />);
});

app.post('/notes', auth.requireUser, async (c) => {
  const body = String((await c.req.parseBody()).body ?? '').trim();
  if (body) await addNote(auth.user(c).email, body.slice(0, 2000));
  return c.redirect('/', 303);
});

mountMcp(app, {
  resource,
  issuer,
  name: cfg.APP_NAME,
  instructions: `${cfg.APP_NAME}: a notes app. Use add_note to save a note, list_notes to read them.`,
  register: (server, user) => {
    server.registerTool(
      'add_note',
      {
        title: 'Add a note',
        description: 'Saves a note (also copied to the app bucket).',
        inputSchema: { body: z.string().min(1).max(2000) },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ body }) => {
        const n = await addNote(user.email, body);
        return { content: [{ type: 'text', text: `Saved note #${n.id}.` }] };
      },
    );
    server.registerTool(
      'list_notes',
      {
        title: 'List notes',
        description: 'The most recent notes, newest first.',
        inputSchema: { limit: z.number().int().min(1).max(200).optional() },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ limit }) => ({
        content: [{ type: 'text', text: JSON.stringify(await listNotes(limit ?? 20), null, 2) }],
      }),
    );
  },
});

const server = Bun.serve({ port: cfg.PORT, hostname: '0.0.0.0', fetch: app.fetch });
log.info('listening', { port: server.port, commit: cfg.GIT_SHA });
process.on('SIGTERM', async () => {
  await server.stop();
  await sql?.end({ timeout: 5 });
  process.exit(0);
});
