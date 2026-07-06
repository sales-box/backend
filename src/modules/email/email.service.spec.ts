import { Test, TestingModule } from '@nestjs/testing';
import { EmailService } from '@/modules/email/email.service';
import { EmailProvider } from '@/modules/email/email-provider.abstract';
import { ParsedMessage } from '@/modules/email/email.types';

const stubMessage: ParsedMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  subject: 'Hello',
  from: 'a@example.com',
  to: 'b@example.com',
  date: '2024-01-01',
  textPlain: 'body',
  textHtml: '<p>body</p>',
  attachments: [],
};

describe('EmailService', () => {
  let service: EmailService;
  let mockGetMessage: jest.Mock;
  let mockGetThreads: jest.Mock;

  beforeEach(async () => {
    mockGetMessage = jest.fn();
    mockGetThreads = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: EmailProvider,
          useValue: {
            fetchMessage: mockGetMessage,
            fetchThreads: mockGetThreads,
          },
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  it('delegates fetchMessage to the provider with correct arguments', async () => {
    mockGetMessage.mockResolvedValue(stubMessage);

    const result = await service.fetchMessage('msg-1', 'account-1');

    expect(mockGetMessage).toHaveBeenCalledTimes(1);
    expect(mockGetMessage).toHaveBeenCalledWith('msg-1', 'account-1');
    expect(result).toEqual(stubMessage);
  });

  it('propagates errors thrown by the provider', async () => {
    mockGetMessage.mockRejectedValue(new Error('Provider failure'));

    await expect(service.fetchMessage('msg-1', 'account-1')).rejects.toThrow(
      'Provider failure',
    );
  });

  it('delegates fetchThreads to the provider with correct arguments', async () => {
    const mockThreads = [{ id: 'thread-1', snippet: 'snip', messages: [] }];
    mockGetThreads.mockResolvedValue(mockThreads);

    const result = await service.fetchThreads('account-1', 'query-1');

    expect(mockGetThreads).toHaveBeenCalledTimes(1);
    expect(mockGetThreads).toHaveBeenCalledWith('account-1', 'query-1');
    expect(result).toEqual(mockThreads);
  });

  it('propagates errors thrown by fetchThreads provider', async () => {
    mockGetThreads.mockRejectedValue(new Error('Threads failure'));

    await expect(service.fetchThreads('account-1', 'query-1')).rejects.toThrow(
      'Threads failure',
    );
  });
});
