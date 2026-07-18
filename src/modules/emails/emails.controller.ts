import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { EmailsService } from './emails.service';
import { GetThreadHistoryDto } from './emails.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';

@ApiTags('emails')
@Controller('emails')
export class EmailsController {
  constructor(private readonly emailsService: EmailsService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('inbox-stats')
  @ApiOkResponse({
    description: 'Inbox statistics for the SE',
    schema: {
      type: 'object',
      properties: {
        totalEmails: { type: 'number' },
        syncedAt: { type: 'string', format: 'date-time' },
        urgentCount: { type: 'number' },
        intentBreakdown: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
        reviewedBreakdown: {
          type: 'object',
          properties: {
            green: { type: 'number' },
            yellow: { type: 'number' },
            red: { type: 'number' },
          },
          required: ['green', 'yellow', 'red'],
        },
        notYetReviewedCount: { type: 'number' },
      },
    },
  })
  async getInboxStats(@Req() req: AuthenticatedRequest) {
    return this.emailsService.getInboxStatsForSe(
      req.user.email,
      req.user.tenantId ?? undefined,
    );
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('thread-history')
  @ApiOkResponse({
    description: 'List of email threads with the client',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', format: 'date-time' },
          subject: { type: 'string' },
          snippet: { type: 'string' },
          direction: { type: 'string', enum: ['inbound', 'outbound'] },
        },
      },
    },
  })
  @ApiQuery({ name: 'email', description: 'Client email address' })
  @ApiHeader({
    name: 'x-gmail-token',
    description: 'Gmail access token',
    required: true,
  })
  async getThreadHistory(
    @Query() query: GetThreadHistoryDto,
    @Headers('x-gmail-token') token?: string,
  ) {
    if (!token) {
      throw new BadRequestException(
        'Gmail access token is required in x-gmail-token header',
      );
    }
    return this.emailsService.fetchThreadsForClient(query.email, token);
  }
}
