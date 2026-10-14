/* eslint-disable @typescript-eslint/unbound-method */
import { Queue } from 'bullmq';
import { GmailParserService } from '../gmail-parser.service';
import { GmailWebhookController } from './gmail-webhook.controller';
import { GmailPubSubNotificationDto } from './dtos/gmail-pub-sub-notification.dto';
import { CLASSIFY_EMAIL_JOB } from '../../../ai/classifier/classifier.constants';

describe('GmailWebhookController', () => {
  const decoded = { emailAddress: 'se@acme.com', historyId: '4711' };

  function makeController() {
    const parser = {
      parsePubSubNotificationPayload: jest.fn().mockReturnValue(decoded),
    } as unknown as GmailParserService;
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'j1' }),
    } as unknown as Queue;
    return {
      controller: new GmailWebhookController(parser, queue),
      parser,
      queue,
    };
  }

  const body = {
    subscription: 'projects/x/subscriptions/y',
    message: { data: 'base64data', messageId: 'pubsub-1' },
  } as GmailPubSubNotificationDto;

  it('decodes the notification and enqueues a classify job with a dedup jobId', async () => {
    const { controller, parser, queue } = makeController();

    const result = await controller.handleIncomingNotification(body);

    expect(parser.parsePubSubNotificationPayload).toHaveBeenCalledWith(
      'base64data',
    );
    expect(queue.add).toHaveBeenCalledWith(
      CLASSIFY_EMAIL_JOB,
      decoded,
      expect.objectContaining({
        jobId: 'se@acme.com#4711',
        // 5 attempts spaced 15s→2min: wide enough for a free-tier LLM quota
        // window to reopen instead of burning all retries inside one minute.
        attempts: 5,
        backoff: { type: 'exponential', delay: 15000 },
      }),
    );
    expect(result).toEqual({ ok: true });
  });
});
