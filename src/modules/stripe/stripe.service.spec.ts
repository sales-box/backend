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
    it('should call stripe.paymentIntents.create with correct parameters', async () => {
      mockCreate.mockResolvedValue({
        id: 'pi_test_123',
        client_secret: 'secret_123',
      });

      const result = await service.createPaymentIntent('tenant-abc', 5000);

      expect(mockCreate).toHaveBeenCalledWith({
        amount: 5000,
        currency: 'usd',
        metadata: {
          tenantId: 'tenant-abc',
        },
      });
      expect(result).toEqual({
        id: 'pi_test_123',
        client_secret: 'secret_123',
      });
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
