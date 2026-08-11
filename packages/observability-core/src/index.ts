// @ratio/observability-core — the pure, runtime-agnostic logging discipline shared by the Node (pino)
// and edge (Cloudflare Workers) loggers. NO deps, NO Node APIs, so it is safe to import from a Worker.
// This is the single source of the system's log conventions: the Logger shape, the redaction backstop,
// and classifyError (map any throw to a CLOSED taxonomy + type name, so an untrusted upstream error
// message — which can carry a token/PII — never enters a log line).

export type Level = 'info' | 'warn' | 'error';

// The minimal logger both runtimes implement. It matches pino's info/warn/error/child, so the Node
// logger IS a pino.Logger and the edge logger mirrors it — one call-site API across every service.
export interface Logger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
  child(bindings: Record<string, string>): Logger;
}

// Bind a per-request correlation id. Every event under this child carries reqId, so one request's
// lines group together and correlate with the edge access log (and, later, an OTel trace).
export function requestLog(base: Logger, reqId: string): Logger {
  return base.child({ reqId });
}

// A request/correlation id is echoed on responses and stamped on every log line, so a client-supplied
// one is UNTRUSTED and must be bounded (charset + length) — else it's a log-forging / line-size vector.
// Returns the id if it's a safe token, otherwise null (caller mints a fresh one).
const REQ_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
export function sanitizeReqId(raw: string | undefined | null): string | null {
  return raw && REQ_ID_RE.test(raw) ? raw : null;
}

// Secret-bearing keys scrubbed as defense-in-depth. Events are built from closed field sets, but this
// guards a future careless call site that spreads one in.
export const REDACT_KEYS = ['token', 'cookie', 'authorization', 'password', 'secret'] as const;

// Map any thrown value to a stable, non-sensitive shape: a closed taxonomy `code` + the error's type
// name. NEVER the raw message — an upstream backend's error text is untrusted (tokens, PII, URLs).
export function classifyError(e: unknown): { code: string; errType: string } {
  const err = e instanceof Error ? e : new Error(String(e));
  const errType = err.name || 'Error';
  const code = (err as { code?: unknown }).code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN'
  )
    return { code: 'network', errType };
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return { code: 'timeout', errType };
  return { code: 'error', errType };
}
