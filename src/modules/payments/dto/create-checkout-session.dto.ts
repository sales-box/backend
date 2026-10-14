import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt } from 'class-validator';
import { SELF_SERVE_TIERS } from '../plans';

export class CreateCheckoutSessionDto {
  @ApiProperty({
    description:
      'Plan tier to subscribe to. Enterprise is quoted per customer and is not self-serve.',
    enum: SELF_SERVE_TIERS,
    example: 2,
  })
  @IsInt()
  @IsIn(SELF_SERVE_TIERS)
  tier!: number;
}
