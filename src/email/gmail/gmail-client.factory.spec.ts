import { GmailClientFactory } from '@/email/gmail/gmail-client.factory';
import { google } from 'googleapis';

jest.mock('googleapis', () => {
  const mockSetCredentials = jest.fn();
  const MockOAuth2 = jest.fn(() => ({ setCredentials: mockSetCredentials }));
  const mockGmail = jest.fn().mockReturnValue({ users: {} });

  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: mockGmail,
    },
  };
});

describe('GmailClientFactory', () => {
  let factory: GmailClientFactory;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GMAIL_CLIENT_ID = 'test-client-id';
    process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';
    factory = new GmailClientFactory();
  });

  it('creates an OAuth2 client with env var credentials', async () => {
    await factory.createClient('account-1');

    const MockOAuth2 = google.auth.OAuth2 as unknown as jest.Mock;
    expect(MockOAuth2).toHaveBeenCalledWith({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    });
  });

  it('sets credentials on the OAuth2 instance', async () => {
    await factory.createClient('account-1');

    const MockOAuth2 = google.auth.OAuth2 as unknown as jest.Mock;
    type AuthStub = { setCredentials: jest.Mock };
    const authInstance = MockOAuth2.mock.results[0]
      .value as unknown as AuthStub;
    expect(authInstance.setCredentials).toHaveBeenCalledWith({});
  });

  it('returns a Gmail v1 client', async () => {
    const mockGmail = google.gmail as unknown as jest.Mock;
    const anyObject: jest.AsymmetricMatcher = expect.any(
      Object,
    ) as jest.AsymmetricMatcher;

    await factory.createClient('account-1');

    expect(mockGmail).toHaveBeenCalledWith({ version: 'v1', auth: anyObject });
  });
});
