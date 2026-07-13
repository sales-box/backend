import { Test, TestingModule } from '@nestjs/testing';
import { PaymentService } from './payment.service';
import { StripeService } from '../stripe/stripe.service';
import { PrismaService } from '@/database/prisma.service';
import { Logger } from '@nestjs/common';
import Stripe from 'stripe';

describe('PaymentService', () => {
  let service: PaymentService;
  let logger: Logger;

  const mockStripeService = {
    createPaymentIntent: jest.fn(),
    getPayment: jest.fn(),
  };

  const mockTenantFindUnique = jest.fn();
  const mockPrismaService = {
    tenant: {
      findUnique: mockTenantFindUnique,
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: StripeService, useValue: mockStripeService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
    logger = (service as unknown as { logger: Logger }).logger;
    jest.clearAllMocks();
  });

  describe('createPaymentIntent', () => {
    it('should delegate to stripeService.createPaymentIntent', async () => {
      mockStripeService.createPaymentIntent.mockResolvedValue({ id: 'pi_123' });

      const result = await service.createPaymentIntent('tenant-abc', 5000);

      expect(mockStripeService.createPaymentIntent).toHaveBeenCalledWith(
        'tenant-abc',
        5000,
      );
      expect(result).toEqual({ id: 'pi_123' });
    });
  });

  describe('getPayment', () => {
    it('should delegate to stripeService.getPayment', async () => {
      mockStripeService.getPayment.mockResolvedValue({
        id: 'pi_123',
        amount: 5000,
      });

      const result = await service.getPayment('tenant-abc', 'pi_123');

      expect(mockStripeService.getPayment).toHaveBeenCalledWith(
        'tenant-abc',
        'pi_123',
      );
      expect(result).toEqual({ id: 'pi_123', amount: 5000 });
    });
  });

  describe('paymentSucceeded', () => {
    const mockPaymentIntent = {
      id: 'pi_123',
      amount: 5000,
      metadata: { tenantId: 'tenant-abc' },
    } as unknown as Stripe.PaymentIntent;

    it('should log warning and exit early if tenantId is missing in metadata', async () => {
      const loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation();
      const piWithoutMetadata = { ...mockPaymentIntent, metadata: {} };

      await service.paymentSucceeded(piWithoutMetadata);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'Payment succeeded without tenant ID in metadata. ID: pi_123',
      );
      expect(mockTenantFindUnique).not.toHaveBeenCalled();
      loggerWarnSpy.mockRestore();
    });

    it('should log error if tenant does not exist in the database', async () => {
      const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();
      mockTenantFindUnique.mockResolvedValue(null);

      await service.paymentSucceeded(mockPaymentIntent);

      expect(mockTenantFindUnique).toHaveBeenCalledWith({
        where: { id: 'tenant-abc' },
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Payment succeeded for non-existent tenant: tenant-abc. ID: pi_123',
      );
      loggerErrorSpy.mockRestore();
    });

    it('should log success if tenant exists in the database', async () => {
      const loggerLogSpy = jest.spyOn(logger, 'log').mockImplementation();
      mockTenantFindUnique.mockResolvedValue({
        id: 'tenant-abc',
        companyName: 'Acme Corp',
      });

      await service.paymentSucceeded(mockPaymentIntent);

      expect(loggerLogSpy).toHaveBeenCalledWith(
        'Payment succeeded for tenant Acme Corp (tenant-abc). Amount: 50 USD. PaymentIntent ID: pi_123',
      );
      loggerLogSpy.mockRestore();
    });
  });

  describe('paymentFailed', () => {
    const mockPaymentIntent = {
      id: 'pi_123',
      metadata: { tenantId: 'tenant-abc' },
    } as unknown as Stripe.PaymentIntent;

    it('should log warning if tenantId is missing in metadata', async () => {
      const loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation();
      const piWithoutMetadata = { ...mockPaymentIntent, metadata: {} };

      await service.paymentFailed(piWithoutMetadata);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'Payment failed without tenant ID in metadata. ID: pi_123',
      );
      loggerWarnSpy.mockRestore();
    });

    it('should log failure error with tenant ID', async () => {
      const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation();

      await service.paymentFailed(mockPaymentIntent);

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Payment failed for tenant: tenant-abc. ID: pi_123',
      );
      loggerErrorSpy.mockRestore();
    });
  });
});
