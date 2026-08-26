import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
  Param,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import {
  ApiTags,
  ApiOkResponse,
  ApiBearerAuth,
  ApiOperation,
  ApiCreatedResponse,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';
import { NoSubscriptionRequired } from '../../common/guards/assert-subscription-active';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

@ApiTags('payments')
@ApiBearerAuth()
@NoSubscriptionRequired()
@UseGuards(JwtAuthGuard, AdminTenantGuard)
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create-checkout-session')
  @ApiOperation({
    summary: 'Create a Stripe Checkout Session for a subscription',
    description:
      'Returns a Stripe-hosted checkout URL. The frontend redirects the user there; ' +
      'Stripe handles card collection. After payment, the webhook activates the subscription.',
  })
  @ApiCreatedResponse({
    description: 'Checkout session created (redirect URL returned).',
  })
  async createCheckoutSession(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    return this.paymentService.createCheckoutSession(
      req.user.tenantId!,
      dto.tier,
      req.user.email,
    );
  }

  @Get('session/:id')
  @ApiOperation({ summary: 'Get a checkout session by id' })
  @ApiParam({ name: 'id', description: 'Checkout session id' })
  @ApiOkResponse({ description: 'The checkout session.' })
  async getSession(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.paymentService.getCheckoutSession(id, req.user.tenantId!);
  }
}
