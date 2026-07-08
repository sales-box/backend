import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { EmailsService } from './emails.service';
import { GetThreadHistoryDto } from './emails.dto';

@ApiTags('emails')
@Controller('emails')
export class EmailsController {
  constructor(private readonly emailsService: EmailsService) {}

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
