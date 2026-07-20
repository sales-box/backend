import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Body,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { AnalyticsSummary, TeamMemberStats } from './types/analytics.types';
import { KnowledgeGap } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';
import { ReportGapDto } from './dto/report-gap.dto';
import { ActivityFeedQueryDto } from './dto/activity-feed-query.dto';

// Admin-only, tenant-scoped. JwtAuthGuard authenticates and populates req.user;
// AdminTenantGuard then confirms the caller is an admin of a tenant. The tenant
// id comes from the verified token, never the request, so one tenant's admin can
// never read another tenant's numbers (and can't widen the scope by omitting it).
@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminTenantGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('activity')
  @ApiOperation({ summary: 'Get cross-SE activity feed for the tenant' })
  @ApiResponse({
    status: 200,
    description: 'The activity feed has been successfully retrieved.',
  })
  async getActivityFeed(
    @Query() query: ActivityFeedQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.analyticsService.getActivityFeed(req.user.tenantId!, query);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Get the analytics dashboard summary' })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Look-back window in days (default 30)',
  })
  @ApiResponse({ status: 200, description: 'Aggregated analytics summary.' })
  async getSummary(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnalyticsSummary> {
    return this.analyticsService.getAnalyticsSummary(days, req.user.tenantId!);
  }

  @Get('team')
  @ApiOperation({
    summary:
      'Get per-SE activity for the tenant: logins and reply volume (real signal, not a one-time badge)',
  })
  @ApiResponse({
    status: 200,
    description: 'Per-SE team stats for the tenant.',
  })
  async getTeamStats(
    @Req() req: AuthenticatedRequest,
  ): Promise<TeamMemberStats[]> {
    return this.analyticsService.getTeamStats(req.user.tenantId!);
  }

  @Get('gaps/alerts')
  @ApiOperation({
    summary: 'List knowledge gaps that crossed the alert threshold',
  })
  @ApiQuery({
    name: 'threshold',
    required: false,
    type: Number,
    description: 'Minimum occurrence count to alert on (default 3)',
  })
  @ApiResponse({
    status: 200,
    description: 'Knowledge gaps at or above the threshold.',
  })
  async getAlerts(
    @Query('threshold', new DefaultValuePipe(3), ParseIntPipe)
    threshold: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<KnowledgeGap[]> {
    return this.analyticsService.getKnowledgeGapAlerts(
      threshold,
      req.user.tenantId ?? undefined,
    );
  }

  @Post('gaps')
  @ApiOperation({ summary: 'Report a new knowledge gap' })
  @ApiResponse({
    status: 201,
    description: 'The knowledge gap has been successfully reported.',
  })
  async reportGap(
    @Body() dto: ReportGapDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<KnowledgeGap> {
    return this.analyticsService.upsertKnowledgeGap(
      dto.topic,
      req.user.tenantId ?? undefined,
    );
  }

  // TODO(analytics-tenant-scope): resolveGap(id) is not tenant-scoped in the
  // service yet, so a gap is resolved by id alone. It's behind the admin guard,
  // but a tenant-scoped resolveGap(tenantId, id) should replace this once the
  // AnalyticsService supports it (coordinate with Mohamed Khaled).
  @Patch('gaps/:id/resolve')
  @ApiOperation({ summary: 'Mark a knowledge gap as resolved' })
  @ApiParam({ name: 'id', description: 'Knowledge gap id' })
  @ApiResponse({ status: 200, description: 'The resolved knowledge gap.' })
  async resolveGap(@Param('id') id: string): Promise<KnowledgeGap> {
    return this.analyticsService.resolveGap(id);
  }
}
