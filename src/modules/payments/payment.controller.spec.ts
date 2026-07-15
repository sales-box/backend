import { Test, TestingModule } from '@nestjs/testing';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

describe('PaymentController', () => {
  let controller: PaymentController;

  const mockPaymentService = {
    createPaymentIntent: jest.fn(),
    getPayment: jest.fn(),
  };

  const tenantId = 'tenant-abc';

  /** Minimal AuthenticatedRequest stub that satisfies the controller methods. */
  const mockReq = {
    user: { tenantId, isAdmin: true, email: 'admin@example.com', sub: 'acc-1' },
  } as unknown as import('../auth/jwt-auth.guard').AuthenticatedRequest;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [{ provide: PaymentService, useValue: mockPaymentService }],
    })
      // Guard logic is tested separately; skip here to keep unit tests fast.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminTenantGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PaymentController>(PaymentController);
    jest.clearAllMocks();
  });

  describe('createPaymentIntent', () => {
    it('should call paymentService.createPaymentIntent with tenantId from JWT', async () => {
      mockPaymentService.createPaymentIntent.mockResolvedValue({
        id: 'pi_123',
      });

      const result = await controller.createPaymentIntent(mockReq, 5000);

      expect(mockPaymentService.createPaymentIntent).toHaveBeenCalledWith(
        tenantId,
        5000,
        undefined,
      );
      expect(result).toEqual({ id: 'pi_123' });
    });
  });

  describe('getPayment', () => {
    it('should call paymentService.getPayment with tenantId from JWT', async () => {
      mockPaymentService.getPayment.mockResolvedValue({
        id: 'pi_123',
        amount: 5000,
      });

      const result = await controller.getPayment(mockReq, 'pi_123');

      expect(mockPaymentService.getPayment).toHaveBeenCalledWith(
        tenantId,
        'pi_123',
      );
      expect(result).toEqual({ id: 'pi_123', amount: 5000 });
    });
  });
});
