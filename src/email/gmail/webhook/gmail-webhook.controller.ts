import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { GmailWebhookGuard } from '@/email/gmail/webhook/gmail-webhook.guard';
import { GmailPubSubNotificationDto } from './dtos/gmail-pub-sub-notification.dto';
import { GmailParserService } from '../gmail-parser.service';
import { DecodedGmailHistory } from '../gmail.types';

@Controller('gmail/webhook')
export class GmailWebhookController {
  constructor(private readonly parser: GmailParserService) {
    this.parser = parser;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(GmailWebhookGuard)
  handleIncomingNotification(@Body() body: GmailPubSubNotificationDto) {
    const decodedHistory: DecodedGmailHistory =
      this.parser.parsePubSubNotificationPayload(body.message.data);

    console.log('Received Gmail Pub/Sub notification:', decodedHistory);

    return { ok: true };
  }
}
