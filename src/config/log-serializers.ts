import { stdSerializers, type LogFn } from 'pino';
import { sanitizeForLog } from '../utils/pii-mask.util';

type RawReq = Parameters<typeof stdSerializers.req>[0];

/** Logs the request URL without its query string so credentials in query params are never written to logs. */
export function reqSerializer(
  req: RawReq,
): ReturnType<typeof stdSerializers.req> {
  const serialized = stdSerializers.req(req);
  if (typeof serialized.url === 'string') {
    const q = serialized.url.indexOf('?');
    if (q !== -1) {
      serialized.url = serialized.url.slice(0, q);
    }
  }
  return serialized;
}

/**
 * Pino `logMethod` hook: runs every string argument of every log call through
 * `sanitizeForLog` before Pino writes it, so PII in the free-text message is
 * masked automatically — no call site has to remember.
 *
 * This is the key piece: Pino serializers only see object bindings (req/res),
 * NEVER the message string, so a plain `logger.log('...01012345678...')` leaks
 * without it.
 *
 * SCOPE (deliberate): STRING arguments only. Every PII log site in this codebase
 * passes PII as a template string (e.g. `for ${client.email}`), so this covers
 * 100% of current PII. We do NOT deep-walk objects — nothing here logs PII inside
 * an object, and cloning + walking every logged object on every call would cost
 * CPU for a case that does not occur.
 *
 * FUTURE: if code starts logging PII *inside objects* (likely once the AI phase
 * logs structured extracted content), add a `formatters.log` deep-masker here —
 * masking a COPY, never the caller's object, to avoid corrupting live data.
 */
export function maskLogMethod(
  this: unknown,
  args: Parameters<LogFn>,
  method: LogFn,
): void {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'string') {
      (args as unknown[])[i] = sanitizeForLog(args[i] as string);
    }
  }
  method.apply(this, args);
}
