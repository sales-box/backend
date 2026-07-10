import pino from 'pino';
import { reqSerializer, maskLogMethod } from './log-serializers';

describe('reqSerializer', () => {
  it('strips the query string so an OAuth code can never reach the logs', () => {
    const serialized = reqSerializer({
      id: 'req-1',
      method: 'GET',
      url: '/auth/google/callback?code=SUPER_SECRET_CODE&state=xyz&scope=s',
      headers: {},
    } as never);

    expect(serialized.url).toBe('/auth/google/callback');
    expect(JSON.stringify(serialized)).not.toContain('SUPER_SECRET_CODE');
  });

  it('leaves a query-less URL untouched', () => {
    const serialized = reqSerializer({
      id: 'req-2',
      method: 'GET',
      url: '/health',
      headers: {},
    } as never);

    expect(serialized.url).toBe('/health');
  });
});

describe('maskLogMethod (PII masking hook)', () => {
  /** Builds a real Pino logger with the hook, capturing each JSON line it emits. */
  function makeLogger() {
    const lines: Array<Record<string, unknown>> = [];
    const stream = {
      write: (chunk: string) => {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    };
    const logger = pino({ hooks: { logMethod: maskLogMethod } }, stream);
    return { logger, lines };
  }

  it('masks a phone number in the message string (the core requirement)', () => {
    const { logger, lines } = makeLogger();
    logger.info('my phone is 01012345678');

    expect(lines[0].msg).toBe('my phone is 010****5678');
    // The raw number must appear nowhere in the emitted line.
    expect(JSON.stringify(lines[0])).not.toContain('01012345678');
  });

  it('masks PII passed as a secondary string argument too', () => {
    const { logger, lines } = makeLogger();
    logger.info('card seen: %s', '4111 1111 1111 1111');

    expect(JSON.stringify(lines[0])).not.toContain('4111 1111 1111 1111');
    expect(lines[0].msg).toContain('**** **** **** 1111');
  });

  it('leaves object bindings and non-PII messages untouched', () => {
    const { logger, lines } = makeLogger();
    logger.info({ userId: 42, route: '/health' }, 'request ok');

    expect(lines[0].msg).toBe('request ok');
    expect(lines[0].userId).toBe(42);
    expect(lines[0].route).toBe('/health');
  });
});
