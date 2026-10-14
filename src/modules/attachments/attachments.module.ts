import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { AttachmentCacheRepository } from './attachment-cache.repository';
import { GmailClientProvider } from '../emails/gmail-client.provider';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../database/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  providers: [
    AttachmentsService,
    AttachmentCacheRepository,
    GmailClientProvider,
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
