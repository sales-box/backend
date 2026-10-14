import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export const TENANT_STATUSES = [
  'pending',
  'active',
  'suspended',
  'abandoned',
  'offboarded',
] as const;
export type TenantStatusFilter = (typeof TENANT_STATUSES)[number];

export class ListTenantsQueryDto extends PaginationQueryDto {
  /** Case-insensitive substring match on the company name. */
  @ApiPropertyOptional({ example: 'acme' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: TENANT_STATUSES })
  @IsOptional()
  @IsIn(TENANT_STATUSES)
  status?: TenantStatusFilter;
}
