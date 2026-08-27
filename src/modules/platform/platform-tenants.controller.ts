import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlatformGuard } from './platform.guard';
import { PlatformTenantsService } from './platform-tenants.service';
import { PlatformMembersService } from './platform-members.service';
import { ChangeStatusDto } from './dto/change-status.dto';
import { ChangeTierDto } from './dto/change-tier.dto';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';

@ApiTags('platform')
@UseGuards(PlatformGuard)
@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(
    private readonly service: PlatformTenantsService,
    private readonly members: PlatformMembersService,
  ) {}

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

  /**
   * Everyone in one workspace — seats and connected mailboxes, merged.
   *
   * Sits above `@Get(':id')` in the file for readability only; Express matches
   * on segment count, so the two-segment route cannot be swallowed by `:id`.
   */
  @Get(':id/members')
  listMembers(@Param('id', ParseUUIDPipe) id: string) {
    return this.members.list(id);
  }

  /**
   * Remove one person from one workspace, permanently, and free their address.
   *
   * Answers 200 with what was actually removed rather than 204: the console
   * needs to know whether it just deleted the workspace's admin.
   */
  @Delete(':id/members/:email')
  @HttpCode(HttpStatus.OK)
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('email') email: string,
  ) {
    return this.members.remove(id, email);
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

  /** Permanently destroy an offboarded tenant and all of its data. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  purge(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.purge(id);
  }
}
