import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  BadRequestException,
  Param,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { ApiTags, ApiOkResponse } from '@nestjs/swagger';

@ApiTags('payments')
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create-payment-intent')
  async createPaymentIntent(
    @Headers('x-tenant-id') tenantId: string,
    @Body('amount') amount: number,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    return this.paymentService.createPaymentIntent(tenantId, amount);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Get payment by id' })
  async getPayment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') id: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    return this.paymentService.getPayment(tenantId, id);
  }
}
