// Env vars must be set before any import that triggers plans.ts evaluation
process.env.STRIPE_PRICE_STARTER = 'price_starter';
process.env.STRIPE_PRICE_GROWTH = 'price_growth';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { PrismaService } from '@/database/prisma.service';

const mockSessionCreate = jest.fn();
const mockSessionRetrieve = jest.fn();
const mockCustomerCreate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockSessionCreate,
        retrieve: mockSessionRetrieve,
      },
    },
    customers: {
      create: mockCustomerCreate,
    },
  }));
});

describe('StripeService', () => {
  let service: StripeService;
  const mockTenantFindUnique = jest.fn();
  const mockTenantUpdate = jest.fn();

  const mockConfig = {
    getOrThrow: jest.fn().mockReturnValue('http://localhost:5173/callback'),
  } as unknown as ConfigService;

  const mockPrisma = {
    tenant: {
      findUnique: mockTenantFindUnique,
      update: mockTenantUpdate,
    },
  } as unknown as PrismaService;

  beforeEach(() => {
    service = new StripeService(mockConfig, mockPrisma);
    jest.clearAllMocks();
  });

  describe('getOrCreateCustomer', () => {
    it('returns existing stripeCustomerId when present', async () => {
      mockTenantFindUnique.mockResolvedValue({
        stripeCustomerId: 'cus_existing',
        companyName: 'Acme',
      });

      const id = await service.getOrCreateCustomer('t-1', 'a@b.com');

      expect(id).toBe('cus_existing');
      expect(mockCustomerCreate).not.toHaveBeenCalled();
    });

    it('creates a Stripe Customer and persists the id when none exists', async () => {
      mockTenantFindUnique.mockResolvedValue({
        stripeCustomerId: null,
        companyName: 'Acme',
      });
      mockCustomerCreate.mockResolvedValue({ id: 'cus_new' });
      mockTenantUpdate.mockResolvedValue({});

      const id = await service.getOrCreateCustomer('t-1', 'a@b.com');

      expect(id).toBe('cus_new');
      expect(mockCustomerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'a@b.com',
          name: 'Acme',
          metadata: { tenantId: 't-1' },
        }),
      );
      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: { stripeCustomerId: 'cus_new' },
      });
    });
  });

  describe('createCheckoutSession', () => {
    it('creates a subscription checkout session for a valid tier', async () => {
      mockTenantFindUnique.mockResolvedValue({
        stripeCustomerId: 'cus_existing',
        companyName: 'Acme',
      });
      mockSessionCreate.mockResolvedValue({
        id: 'cs_123',
        url: 'https://checkout.stripe.com/cs_123',
      });

      const result = await service.createCheckoutSession(
        'tenant-abc',
        1,
        'a@b.com',
      );

      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          customer: 'cus_existing',
          line_items: [{ price: 'price_starter', quantity: 1 }],
        }),
      );
      expect(result).toEqual({
        sessionId: 'cs_123',
        url: 'https://checkout.stripe.com/cs_123',
      });
    });

    it('refuses a tier with no configured plan', async () => {
      await expect(
        service.createCheckoutSession('t', 3, 'a@b.com'),
      ).rejects.toThrow(BadRequestException);
    });

    it('strips path suffix from FRONTEND_DASHBOARD_URL for redirect URLs', async () => {
      mockTenantFindUnique.mockResolvedValue({
        stripeCustomerId: 'cus_x',
        companyName: 'X',
      });
      mockSessionCreate.mockResolvedValue({ id: 'cs_1', url: 'https://...' });

      await service.createCheckoutSession('t-1', 1, 'x@y.com');

      const args = mockSessionCreate.mock.calls[0] as [
        { success_url: string; cancel_url: string },
      ];
      expect(args[0].success_url).toMatch(/^http:\/\/localhost:5173\//);
      expect(args[0].success_url).not.toContain('/callback');
      expect(args[0].cancel_url).toMatch(/^http:\/\/localhost:5173\//);
    });
  });

  describe('getCheckoutSession', () => {
    it('returns the session when tenantId matches', async () => {
      const session = { id: 'cs_1', metadata: { tenantId: 't-1' } };
      mockSessionRetrieve.mockResolvedValue(session);

      const result = await service.getCheckoutSession('cs_1', 't-1');
      expect(result).toEqual(session);
    });

    it('throws NotFoundException if tenantId does not match', async () => {
      mockSessionRetrieve.mockResolvedValue({
        id: 'cs_1',
        metadata: { tenantId: 'other' },
      });

      await expect(service.getCheckoutSession('cs_1', 't-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
