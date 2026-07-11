import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsSummary } from './types/analytics.types';
import { KnowledgeGap } from '@prisma/client';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('summary')
  async getSummary(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    // TODO(admin-auth): derive tenantId from the JWT claim, not the query.
    @Query('tenantId') tenantId?: string,
  ): Promise<AnalyticsSummary> {
    return this.analyticsService.getAnalyticsSummary(days, tenantId);
  }

  @Get('gaps/alerts')
  async getAlerts(
    @Query('threshold', new DefaultValuePipe(3), ParseIntPipe)
    threshold: number,
    // TODO(admin-auth): derive tenantId from the JWT claim, not the query.
    @Query('tenantId') tenantId?: string,
  ): Promise<KnowledgeGap[]> {
    return this.analyticsService.getKnowledgeGapAlerts(threshold, tenantId);
  }

  @Patch('gaps/:id/resolve')
  async resolveGap(@Param('id') id: string): Promise<KnowledgeGap> {
    return this.analyticsService.resolveGap(id);
  }
}
