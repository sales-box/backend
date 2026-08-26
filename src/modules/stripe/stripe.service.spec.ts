import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { StripeService } from './stripe.service';

const mockCreate = jest.fn();
const mockRetrieve = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => {
    return {
      paymentIntents: {
        create: mockCreate,
        retrieve: mockRetrieve,
      },
    };
  });
});

describe('StripeService', () => {
  let service: StripeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StripeService],
    }).compile();

    service = module.get<StripeService>(StripeService);
    jest.clearAllMocks();
  });

  describe('createPaymentIntent', () => {
    it('prices the plan from the server-side table, not from the caller', async () => {
      mockCreate.mockResolvedValue({
        id: 'pi_test_123',
        client_secret: 'secret_123',
      });

      // The caller names a tier and nothing else. This used to take an
      // `amount` argument straight from the request body, and the webhook
      // writes tenant.tier from the same metadata — so the buyer set the price.
      const result = await service.createPaymentIntent('tenant-abc', 1);

      expect(mockCreate).toHaveBeenCalledWith({
        amount: 4900, // Starter, from PLAN_PRICES
        currency: 'usd',
        metadata: { tenantId: 'tenant-abc', tier: '1' },
      });
      expect(result).toEqual({
        id: 'pi_test_123',
        client_secret: 'secret_123',
      });
    });

    it('charges the tier that was asked for, not a cheaper one', async () => {
      mockCreate.mockResolvedValue({ id: 'pi_growth' });

      await service.createPaymentIntent('tenant-abc', 2);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 14900 }),
      );
    });

    it('refuses a tier that has no self-serve price', async () => {
      // Enterprise is quoted per customer. Inventing a number here is how the
      // old checkout ended up sending amount 0.
      await expect(
        service.createPaymentIntent('tenant-abc', 3),
      ).rejects.toThrow(BadRequestException);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('getPayment', () => {
    it('should return the payment intent if the tenantId matches', async () => {
      const mockPI = {
        id: 'pi_test_123',
        metadata: { tenantId: 'tenant-abc' },
      };
      mockRetrieve.mockResolvedValue(mockPI);

      const result = await service.getPayment('tenant-abc', 'pi_test_123');

      expect(mockRetrieve).toHaveBeenCalledWith('pi_test_123');
      expect(result).toEqual(mockPI);
    });

    it('should throw an error if the tenantId does not match metadata', async () => {
      const mockPI = {
        id: 'pi_test_123',
        metadata: { tenantId: 'tenant-different' },
      };
      mockRetrieve.mockResolvedValue(mockPI);

      await expect(
        service.getPayment('tenant-abc', 'pi_test_123'),
      ).rejects.toThrow('Payment intent not found or tenant mismatch');
    });
  });
});
