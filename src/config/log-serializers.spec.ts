import { reqSerializer } from './log-serializers';

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
