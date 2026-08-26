import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlatformGuard } from './platform.guard';
import { PlatformTenantsService } from './platform-tenants.service';
import { ChangeStatusDto } from './dto/change-status.dto';
import { ChangeTierDto } from './dto/change-tier.dto';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';

@ApiTags('platform')
@UseGuards(PlatformGuard)
@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly service: PlatformTenantsService) {}

  /** List all tenants across the platform, optionally filtered. */
  @Get()
  list(@Query() query: ListTenantsQueryDto) {
    return this.service.list(query.page ?? 1, query.limit ?? 20, {
      search: query.search,
      status: query.status,
    });
  }

  /**
   * Platform-wide tenant counts for the operator overview.
   *
   * MUST stay above `@Get(':id')` — that route parses its param as a UUID and
   * would otherwise swallow `/stats` and reject it as malformed.
   */
  @Get('stats')
  stats() {
    return this.service.stats();
  }

  /** One tenant's operational detail. */
  @Get(':id')
  getDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getDetail(id);
  }

  /** Activate / suspend / offboard a tenant. */
  @Patch(':id/status')
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeStatusDto,
  ) {
    return this.service.changeStatus(id, dto.action);
  }

  /** Set a tenant's plan tier (operator override). */
  @Patch(':id/tier')
  changeTier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeTierDto,
  ) {
    return this.service.changeTier(id, dto.tier);
  }
}
