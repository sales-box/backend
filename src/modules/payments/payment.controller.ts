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
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';

@ApiTags('payments')
@ApiBearerAuth()
// JwtAuthGuard authenticates and populates req.user; AdminTenantGuard confirms
// the caller is an admin of a tenant. tenantId is taken from the verified JWT
// so a caller cannot spoof a different tenant by supplying a crafted header.
@UseGuards(JwtAuthGuard, AdminTenantGuard)
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create-payment-intent')
  @ApiOperation({
    summary: 'Create a Stripe payment intent for the tenant',
    description:
      'The caller names a plan tier; the price is looked up server-side. The old `amount` field is gone — it let the buyer set their own price.',
  })
  @ApiCreatedResponse({
    description: 'Payment intent created (client secret returned).',
  })
  async createPaymentIntent(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreatePaymentIntentDto,
  ) {
    return this.paymentService.createPaymentIntent(
      req.user.tenantId!,
      dto.tier,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a payment by id' })
  @ApiParam({ name: 'id', description: 'Payment id' })
  @ApiOkResponse({ description: 'The payment.' })
  async getPayment(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.paymentService.getPayment(req.user.tenantId!, id);
  }
}
