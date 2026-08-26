import { Test, TestingModule } from '@nestjs/testing';
import { PaymentService } from './payment.service';
import { StripeService } from '../stripe/stripe.service';
import { PrismaService } from '@/database/prisma.service';
import Stripe from 'stripe';

describe('PaymentService', () => {
  let service: PaymentService;

  const mockStripeService = {
    createCheckoutSession: jest.fn(),
    getCheckoutSession: jest.fn(),
  };

  const mockTenantFindUnique = jest.fn();
  const mockTenantFindFirst = jest.fn();
  const mockTenantUpdate = jest.fn();

  const mockPrismaService = {
    tenant: {
      findUnique: mockTenantFindUnique,
      findFirst: mockTenantFindFirst,
      update: mockTenantUpdate,
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
    jest.clearAllMocks();
  });

  describe('createCheckoutSession', () => {
    it('should delegate to stripeService', async () => {
      mockStripeService.createCheckoutSession.mockResolvedValue({
        sessionId: 'cs_123',
        url: 'https://checkout.stripe.com/...',
      });

      const result = await service.createCheckoutSession('t-1', 2, 'a@b.com');

      expect(mockStripeService.createCheckoutSession).toHaveBeenCalledWith(
        't-1',
        2,
        'a@b.com',
      );
      expect(result.sessionId).toBe('cs_123');
    });
  });

  describe('handleCheckoutCompleted', () => {
    it('activates subscription and sets tier', async () => {
      mockTenantFindUnique.mockResolvedValue({
        id: 't-1',
        subscribedAt: null,
      });
      mockTenantUpdate.mockResolvedValue({});

      await service.handleCheckoutCompleted({
        id: 'cs_1',
        metadata: { tenantId: 't-1', tier: '2' },
        customer: 'cus_abc',
      } as unknown as Stripe.Checkout.Session);

      expect(mockTenantUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't-1' },
        }),
      );
      const updateCall = mockTenantUpdate.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(updateCall[0].data).toMatchObject({
        subscriptionStatus: 'active',
        tier: 2,
        stripeCustomerId: 'cus_abc',
      });
    });

    it('skips if tenantId is missing from metadata', async () => {
      await service.handleCheckoutCompleted({
        id: 'cs_2',
        metadata: {},
      } as unknown as Stripe.Checkout.Session);

      expect(mockTenantFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('handleInvoicePaid', () => {
    it('restores a past_due tenant to active', async () => {
      mockTenantFindFirst.mockResolvedValue({ id: 't-1' });
      mockTenantFindUnique.mockResolvedValue({
        subscriptionStatus: 'past_due',
      });
      mockTenantUpdate.mockResolvedValue({});

      await service.handleInvoicePaid({
        id: 'inv_1',
        customer: 'cus_abc',
      } as unknown as Stripe.Invoice);

      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: { subscriptionStatus: 'active' },
      });
    });

    it('skips write for an already-active tenant', async () => {
      mockTenantFindFirst.mockResolvedValue({ id: 't-1' });
      mockTenantFindUnique.mockResolvedValue({
        subscriptionStatus: 'active',
      });

      await service.handleInvoicePaid({
        id: 'inv_2',
        customer: 'cus_abc',
      } as unknown as Stripe.Invoice);

      expect(mockTenantUpdate).not.toHaveBeenCalled();
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    it('sets active tenant to past_due', async () => {
      mockTenantFindFirst.mockResolvedValue({ id: 't-1' });
      mockTenantFindUnique.mockResolvedValue({
        subscriptionStatus: 'active',
      });
      mockTenantUpdate.mockResolvedValue({});

      await service.handleInvoicePaymentFailed({
        id: 'inv_3',
        customer: 'cus_abc',
      } as unknown as Stripe.Invoice);

      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: { subscriptionStatus: 'past_due' },
      });
    });

    it('does not promote a canceled tenant to past_due', async () => {
      mockTenantFindFirst.mockResolvedValue({ id: 't-1' });
      mockTenantFindUnique.mockResolvedValue({
        subscriptionStatus: 'canceled',
      });

      await service.handleInvoicePaymentFailed({
        id: 'inv_4',
        customer: 'cus_abc',
      } as unknown as Stripe.Invoice);

      expect(mockTenantUpdate).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionDeleted', () => {
    it('cancels the subscription', async () => {
      mockTenantUpdate.mockResolvedValue({});

      await service.handleSubscriptionDeleted({
        id: 'sub_1',
        metadata: { tenantId: 't-1' },
      } as unknown as Stripe.Subscription);

      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: { subscriptionStatus: 'canceled' },
      });
    });
  });

  describe('handleChargeRefunded', () => {
    it('cancels on full refund', async () => {
      mockTenantFindFirst.mockResolvedValue({ id: 't-1' });
      mockTenantUpdate.mockResolvedValue({});

      await service.handleChargeRefunded({
        id: 'ch_1',
        refunded: true,
        customer: 'cus_abc',
      } as unknown as Stripe.Charge);

      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: { subscriptionStatus: 'canceled' },
      });
    });

    it('does nothing on partial refund', async () => {
      await service.handleChargeRefunded({
        id: 'ch_2',
        refunded: false,
        customer: 'cus_abc',
      } as unknown as Stripe.Charge);

      expect(mockTenantUpdate).not.toHaveBeenCalled();
    });
  });
});
