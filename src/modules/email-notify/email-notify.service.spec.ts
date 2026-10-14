import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailNotifyService } from './email-notify.service';
import * as nodemailer from 'nodemailer';

jest.mock('nodemailer');

describe('EmailNotifyService', () => {
  let service: EmailNotifyService;
  let configService: ConfigService;
  let mockSendMail: jest.Mock;

  const getMailOptions = (mock: jest.Mock): { html: string } => {
    const calls = mock.mock.calls as unknown as { html: string }[][];
    return calls[0][0];
  };

  beforeEach(async () => {
    mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({
      sendMail: mockSendMail,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailNotifyService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'SMTP_HOST') return 'smtp.gmail.com';
              if (key === 'SMTP_PORT') return '587';
              if (key === 'SMTP_USER') return 'salesbox.platform@gmail.com';
              if (key === 'SMTP_PASS') return 'pzpylhdvzzjgdmqo';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<EmailNotifyService>(EmailNotifyService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('uses EXTENSION_INSTALL_URL when configured', async () => {
    jest.spyOn(configService, 'get').mockImplementation((key: string) => {
      if (key === 'EXTENSION_INSTALL_URL') {
        return 'https://salesbox.dev/extension-download';
      }
      if (key === 'SMTP_USER') return 'salesbox.platform@gmail.com';
      return null;
    });

    await service.sendSeInvite('se@acme.com');

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mailOptions = getMailOptions(mockSendMail);
    expect(mailOptions.html).toContain(
      'https://salesbox.dev/extension-download',
    );
  });

  it('falls back to FRONTEND_DASHBOARD_URL when EXTENSION_INSTALL_URL is missing', async () => {
    jest.spyOn(configService, 'get').mockImplementation((key: string) => {
      if (key === 'EXTENSION_INSTALL_URL') return null;
      if (key === 'FRONTEND_DASHBOARD_URL') {
        return 'https://salesbox.dev/callback';
      }
      if (key === 'SMTP_USER') return 'salesbox.platform@gmail.com';
      return null;
    });

    await service.sendSeInvite('se@acme.com');

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mailOptions = getMailOptions(mockSendMail);
    expect(mailOptions.html).toContain('https://salesbox.dev/callback');
  });

  it('falls back to hardcoded default URL when both EXTENSION_INSTALL_URL and FRONTEND_DASHBOARD_URL are missing', async () => {
    jest.spyOn(configService, 'get').mockImplementation((key: string) => {
      if (key === 'EXTENSION_INSTALL_URL') return null;
      if (key === 'FRONTEND_DASHBOARD_URL') return null;
      if (key === 'SMTP_USER') return 'salesbox.platform@gmail.com';
      return null;
    });

    await service.sendSeInvite('se@acme.com');

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mailOptions = getMailOptions(mockSendMail);
    expect(mailOptions.html).toContain('https://sales-copilot.app/extension');
  });

  it('logs error and does not throw when sending email fails', async () => {
    mockSendMail.mockRejectedValue(new Error('SMTP connection error'));

    // We expect it not to throw because sendSeInvite catches error internally
    await expect(service.sendSeInvite('se@acme.com')).resolves.not.toThrow();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});
