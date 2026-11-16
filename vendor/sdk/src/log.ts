/**
 * Minimal structured JSON logger. One line per entry on stdout, shaped for
 * Cloud Logging (https://cloud.google.com/logging/docs/structured-logging):
 * `severity`, `message`, and `logging.googleapis.com/trace` get indexed
 * natively, so request logs group under their trace in the console.
 */
export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const severity: Record<LogLevel, Severity> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  /** Defaults to writing a JSON line to stdout. Overridable for tests. */
  sink?: (line: string) => void;
}

const defaultSink = (line: string) => {
  process.stdout.write(`${line}\n`);
};

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = rank[opts.level ?? 'info'];
  const base = opts.base ?? {};
  const sink = opts.sink ?? defaultSink;

  const write = (level: LogLevel, message: string, fields?: LogFields) => {
    if (rank[level] < min) return;
    const entry: LogFields = {
      severity: severity[level],
      message,
      time: new Date().toISOString(),
      ...base,
      ...fields,
    };
    if ('err' in entry) entry.err = serializeError(entry.err);
    // Cloud Logging shows `stack_trace` for errors in Error Reporting.
    if (level === 'error' && entry.err && typeof entry.err === 'object' && 'stack' in entry.err) {
      entry.stack_trace = (entry.err as { stack?: string }).stack;
    }
    sink(JSON.stringify(entry));
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

/**
 * Parses `X-Cloud-Trace-Context: TRACE_ID/SPAN_ID;o=1` (or W3C `traceparent`)
 * into the Cloud Logging trace field.
 */
export function traceFields(
  headers: { get(name: string): string | null },
  projectId: string | undefined,
): LogFields {
  if (!projectId) return {};
  let traceId: string | undefined;
  const cloud = headers.get('x-cloud-trace-context');
  if (cloud) traceId = cloud.split('/')[0];
  if (!traceId) {
    const tp = headers.get('traceparent');
    if (tp) traceId = tp.split('-')[1];
  }
  if (!traceId || !/^[0-9a-f]{16,32}$/i.test(traceId)) return {};
  return { 'logging.googleapis.com/trace': `projects/${projectId}/traces/${traceId}` };
}
