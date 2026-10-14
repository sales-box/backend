import { Module } from '@nestjs/common';
import { FaqController } from './faq.controller';
import { FaqService } from './faq.service';
import { FaqParserService } from './faq-parser.service';
import { PrismaModule } from '../../database/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { GmailModule } from '../email/gmail/gmail.module';

@Module({
  imports: [PrismaModule, AuthModule, GmailModule],
  controllers: [FaqController],
  providers: [FaqService, FaqParserService],
  exports: [FaqService],
})
export class FaqModule {}
