import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PlatformGuard } from './platform.guard';
import { PlatformTenantsService } from './platform-tenants.service';

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
}
