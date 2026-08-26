import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt } from 'class-validator';
import { SELF_SERVE_TIERS } from '../plans';

/**
 * The checkout says WHICH plan, never what it costs.
 *
 * `amount` used to be part of this request and went straight to Stripe. It is
 * gone on purpose: with the global ValidationPipe running
 * `forbidNonWhitelisted`, a client that still sends one now gets a 400 naming
 * the field rather than being quietly charged whatever it asked for.
 */
export class CreatePaymentIntentDto {
  @ApiProperty({
    description:
      'Plan tier to buy. The price is looked up server-side; Enterprise is quoted per customer and is not self-serve.',
    enum: SELF_SERVE_TIERS,
    example: 2,
  })
  @IsInt()
  @IsIn(SELF_SERVE_TIERS)
  tier!: number;
}
