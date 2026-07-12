import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { AnalyticsSummary } from './types/analytics.types';
import { KnowledgeGap } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

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

  @Get('summary')
  async getSummary(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnalyticsSummary> {
    return this.analyticsService.getAnalyticsSummary(
      days,
      req.user.tenantId ?? undefined,
    );
  }

  @Get('gaps/alerts')
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

  // TODO(analytics-tenant-scope): resolveGap(id) is not tenant-scoped in the
  // service yet, so a gap is resolved by id alone. It's behind the admin guard,
  // but a tenant-scoped resolveGap(tenantId, id) should replace this once the
  // AnalyticsService supports it (coordinate with Mohamed Khaled).
  @Patch('gaps/:id/resolve')
  async resolveGap(@Param('id') id: string): Promise<KnowledgeGap> {
    return this.analyticsService.resolveGap(id);
  }
}
