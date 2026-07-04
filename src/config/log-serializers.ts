import { stdSerializers } from 'pino';

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
