import { GmailPollingService } from './gmail-polling.service';

describe('GmailPollingService', () => {
  const accountEmail = 'sales@example.com';

  function buildService() {
    const gmail = {
      users: {
        messages: {
          list: jest.fn(),
        },
      },
    };

    const prisma = {
      connectedAccount: {
        findMany: jest.fn(),
      },
      processedGmailMessage: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    const gmailClientProvider = {
      getClientForAccount: jest.fn(),
    };

    const service = new GmailPollingService(
      prisma as never,
      gmailClientProvider as never,
    );

    return { service, prisma, gmailClientProvider, gmail };
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('fires the polling job every 60 seconds', () => {
    jest.useFakeTimers();
    const { service } = buildService();
    const pollSpy = jest
      .spyOn(service, 'pollAllAccounts')
      .mockResolvedValue(undefined);

    service.onApplicationBootstrap();

    jest.advanceTimersByTime(59_999);
    expect(pollSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(pollSpy).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
  });

  it('fetches only unread Gmail messages from the last 24 hours', async () => {
    const { service, prisma, gmailClientProvider, gmail } = buildService();

    prisma.connectedAccount.findMany.mockResolvedValue([
      { email: accountEmail },
    ]);
    gmailClientProvider.getClientForAccount.mockResolvedValue(gmail);
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [] } });

    await service.pollAllAccounts();

    expect(gmail.users.messages.list).toHaveBeenCalledWith({
      userId: 'me',
      q: 'is:unread newer_than:1d',
      maxResults: 25,
    });
  });

  it('skips a duplicate message_id instead of processing it again', async () => {
    const { service, prisma, gmailClientProvider, gmail } = buildService();

    prisma.connectedAccount.findMany.mockResolvedValue([
      { email: accountEmail },
    ]);
    gmailClientProvider.getClientForAccount.mockResolvedValue(gmail);
    gmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: 'msg-1', threadId: 'thread-1' }] },
    });
    prisma.processedGmailMessage.findUnique.mockResolvedValue({
      messageId: 'msg-1',
    });

    await service.pollAllAccounts();

    expect(prisma.processedGmailMessage.create).not.toHaveBeenCalled();
  });

  it('catches Gmail API errors so the server can keep running', async () => {
    const { service, prisma, gmailClientProvider, gmail } = buildService();

    prisma.connectedAccount.findMany.mockResolvedValue([
      { email: accountEmail },
    ]);
    gmailClientProvider.getClientForAccount.mockResolvedValue(gmail);
    gmail.users.messages.list.mockRejectedValue(new Error('Gmail is down'));

    await expect(service.pollAllAccounts()).resolves.toBeUndefined();
  });
});
