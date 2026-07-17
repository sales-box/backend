import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { GmailWebhookGuard } from '@/modules/email/gmail/webhook/gmail-webhook.guard';
import {
  CLASSIFIER_QUEUE,
  CLASSIFY_EMAIL_JOB,
} from '@/modules/ai/classifier/classifier.constants';
import { ClassifyEmailJobData } from '@/modules/ai/classifier/classifier.types';
import { GmailPubSubNotificationDto } from './dtos/gmail-pub-sub-notification.dto';
import { GmailParserService } from '../gmail-parser.service';
import { DecodedGmailHistory } from '../gmail.types';

@ApiTags('gmail')
@Controller('gmail/webhook')
export class GmailWebhookController {
  private readonly logger = new Logger(GmailWebhookController.name);

  constructor(
    private readonly parser: GmailParserService,
    @InjectQueue(CLASSIFIER_QUEUE) private readonly classifierQueue: Queue,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Gmail Pub/Sub push receiver (called by Google, not interactively)',
    description:
      'Verified by GmailWebhookGuard (Pub/Sub token). Decodes the notification and enqueues the email for classification.',
  })
  @ApiOkResponse({ description: 'Notification accepted and enqueued.' })
  @HttpCode(HttpStatus.OK)
  @UseGuards(GmailWebhookGuard)
  async handleIncomingNotification(@Body() body: GmailPubSubNotificationDto) {
    const decoded: DecodedGmailHistory =
      this.parser.parsePubSubNotificationPayload(body.message.data);

    const jobData: ClassifyEmailJobData = {
      emailAddress: decoded.emailAddress,
      historyId: decoded.historyId,
    };

    // Pub/Sub is at-least-once: the deterministic jobId absorbs redeliveries
    // of the same notification while the job is still in the queue. Per-message
    // dedup (the "exactly once" guarantee) is the DB-unique messageId in
    // general_analysis — two layers with different lifetimes.
    // "#" separator: BullMQ rejects ":" in custom job ids (Redis key separator).
    await this.classifierQueue.add(CLASSIFY_EMAIL_JOB, jobData, {
      jobId: `${decoded.emailAddress}#${decoded.historyId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });

    this.logger.log('Gmail notification enqueued for classification');
    return { ok: true };
  }
}
