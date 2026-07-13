import { Test, TestingModule } from '@nestjs/testing';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { BadRequestException } from '@nestjs/common';

describe('PaymentController', () => {
  let controller: PaymentController;

  const mockPaymentService = {
    createPaymentIntent: jest.fn(),
    getPayment: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [{ provide: PaymentService, useValue: mockPaymentService }],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
    jest.clearAllMocks();
  });

  describe('createPaymentIntent', () => {
    it('should throw BadRequestException if x-tenant-id header is missing', async () => {
      await expect(
        controller.createPaymentIntent(undefined as unknown as string, 5000),
      ).rejects.toThrow(
        new BadRequestException('x-tenant-id header is required'),
      );
    });

    it('should call paymentService.createPaymentIntent when header is provided', async () => {
      mockPaymentService.createPaymentIntent.mockResolvedValue({
        id: 'pi_123',
      });

      const result = await controller.createPaymentIntent('tenant-abc', 5000);

      expect(mockPaymentService.createPaymentIntent).toHaveBeenCalledWith(
        'tenant-abc',
        5000,
      );
      expect(result).toEqual({ id: 'pi_123' });
    });
  });

  describe('getPayment', () => {
    it('should throw BadRequestException if x-tenant-id header is missing', async () => {
      await expect(
        controller.getPayment(undefined as unknown as string, 'pi_123'),
      ).rejects.toThrow(
        new BadRequestException('x-tenant-id header is required'),
      );
    });

    it('should call paymentService.getPayment when header is provided', async () => {
      mockPaymentService.getPayment.mockResolvedValue({
        id: 'pi_123',
        amount: 5000,
      });

      const result = await controller.getPayment('tenant-abc', 'pi_123');

      expect(mockPaymentService.getPayment).toHaveBeenCalledWith(
        'tenant-abc',
        'pi_123',
      );
      expect(result).toEqual({ id: 'pi_123', amount: 5000 });
    });
  });
});
