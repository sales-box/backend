import { Test, TestingModule } from '@nestjs/testing';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

describe('PaymentController', () => {
  let controller: PaymentController;

  const mockPaymentService = {
    createCheckoutSession: jest.fn(),
    getCheckoutSession: jest.fn(),
  };

  const tenantId = 'tenant-abc';
  const mockReq = {
    user: { tenantId, isAdmin: true, email: 'admin@example.com', sub: 'acc-1' },
  } as unknown as import('../auth/jwt-auth.guard').AuthenticatedRequest;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [{ provide: PaymentService, useValue: mockPaymentService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminTenantGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PaymentController>(PaymentController);
    jest.clearAllMocks();
  });

  describe('createCheckoutSession', () => {
    it('delegates to service with tenantId and email from JWT', async () => {
      mockPaymentService.createCheckoutSession.mockResolvedValue({
        sessionId: 'cs_123',
        url: 'https://checkout.stripe.com/...',
      });

      const result = await controller.createCheckoutSession(mockReq, {
        tier: 2,
      });

      expect(mockPaymentService.createCheckoutSession).toHaveBeenCalledWith(
        tenantId,
        2,
        'admin@example.com',
      );
      expect(result.sessionId).toBe('cs_123');
    });
  });

  describe('getSession', () => {
    it('delegates to service with tenantId from JWT', async () => {
      mockPaymentService.getCheckoutSession.mockResolvedValue({
        id: 'cs_123',
      });

      const result = await controller.getSession(mockReq, 'cs_123');

      expect(mockPaymentService.getCheckoutSession).toHaveBeenCalledWith(
        'cs_123',
        tenantId,
      );
      expect(result.id).toBe('cs_123');
    });
  });
});
