import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const TENANT_STATUS_ACTIONS = [
  'activate',
  'suspend',
  'offboard',
] as const;
export type TenantStatusAction = (typeof TENANT_STATUS_ACTIONS)[number];

export class ChangeStatusDto {
  @ApiProperty({ enum: TENANT_STATUS_ACTIONS })
  @IsIn(TENANT_STATUS_ACTIONS)
  action!: TenantStatusAction;
}
