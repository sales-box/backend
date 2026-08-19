import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const TENANT_TIERS = [1, 2, 3] as const;
export type TenantTier = (typeof TENANT_TIERS)[number];

export class ChangeTierDto {
  @ApiProperty({ enum: TENANT_TIERS, example: 2 })
  @IsIn(TENANT_TIERS)
  tier!: TenantTier;
}
