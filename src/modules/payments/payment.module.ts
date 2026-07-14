import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { StripeController } from '../stripe/stripe.controller';
import { StripeModule } from '../stripe/stripe.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  controllers: [PaymentController, StripeController],
  providers: [PaymentService],
  exports: [PaymentService],
  imports: [StripeModule, AuthModule],
})
export class PaymentModule {}
