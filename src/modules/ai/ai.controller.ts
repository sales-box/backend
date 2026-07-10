import { Controller, Post, NotImplementedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

/**
 * Placeholder for the future AI-processing endpoint.
 */
@ApiTags('ai')
@Controller('ai')
export class AiController {
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 requests per minute per IP
  @Post('process')
  @ApiOperation({
    summary: 'AI processing (placeholder — not implemented yet)',
  })
  process(): never {
    throw new NotImplementedException('AI processing is not implemented yet');
  }
}
