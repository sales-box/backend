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
import { ApiTags, ApiOkResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

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
  async createPaymentIntent(
    @Req() req: AuthenticatedRequest,
    @Body('amount') amount: number,
    @Body('tier') tier?: number,
  ) {
    return this.paymentService.createPaymentIntent(
      req.user.tenantId!,
      amount,
      tier,
    );
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Get payment by id' })
  async getPayment(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.paymentService.getPayment(req.user.tenantId!, id);
  }
}
