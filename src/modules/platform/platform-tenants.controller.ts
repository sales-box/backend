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
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PlatformGuard } from './platform.guard';
import { PlatformTenantsService } from './platform-tenants.service';
import { ChangeStatusDto } from './dto/change-status.dto';
import { ChangeTierDto } from './dto/change-tier.dto';

@ApiTags('platform')
@UseGuards(PlatformGuard)
@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly service: PlatformTenantsService) {}

  /** List all tenants across the platform. */
  @Get()
  list(@Query() query: PaginationQueryDto) {
    return this.service.list(query.page ?? 1, query.limit ?? 20);
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
