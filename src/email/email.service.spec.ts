import { Test, TestingModule } from '@nestjs/testing';
import { EmailService } from '@/email/email.service';
import { EmailProvider } from '@/email/email-provider.abstract';
import { ParsedMessage } from '@/email/email.types';

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

  beforeEach(async () => {
    mockGetMessage = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: EmailProvider,
          useValue: { getMessage: mockGetMessage },
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  it('delegates getMessage to the provider with correct arguments', async () => {
    mockGetMessage.mockResolvedValue(stubMessage);

    const result = await service.getMessage('msg-1', 'account-1');

    expect(mockGetMessage).toHaveBeenCalledTimes(1);
    expect(mockGetMessage).toHaveBeenCalledWith('msg-1', 'account-1');
    expect(result).toEqual(stubMessage);
  });

  it('propagates errors thrown by the provider', async () => {
    mockGetMessage.mockRejectedValue(new Error('Provider failure'));

    await expect(service.getMessage('msg-1', 'account-1')).rejects.toThrow(
      'Provider failure',
    );
  });
});
