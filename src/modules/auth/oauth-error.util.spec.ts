import { describeOAuthError } from './oauth-error.util';

describe('describeOAuthError', () => {
  it('describes an OAuth token error', () => {
    const out = describeOAuthError({
      name: 'GaxiosError',
      response: {
        status: 400,
        data: { error: 'invalid_grant', error_description: 'Bad code' },
      },
    });
    expect(out).toContain('invalid_grant');
    expect(out).toContain('Bad code');
    expect(out).toContain('HTTP 400');
  });

  it('describes a Google API error object', () => {
    const out = describeOAuthError({
      name: 'GaxiosError',
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: 'Gmail API disabled',
            status: 'PERMISSION_DENIED',
          },
        },
      },
    });
    expect(out).toContain('PERMISSION_DENIED');
    expect(out).toContain('Gmail API disabled');
  });

  it('handles a plain string body', () => {
    const out = describeOAuthError({
      response: { status: 500, data: 'Internal Error' },
    });
    expect(out).toContain('Internal Error');
  });

  it('falls back to the error name when there is no response', () => {
    expect(describeOAuthError(new Error('boom'))).toBe('Error');
  });
});
