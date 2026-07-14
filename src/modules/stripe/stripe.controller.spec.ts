import { Test, TestingModule } from '@nestjs/testing';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { PaymentService } from '../payments/payment.service';
import * as fastify from 'fastify';

describe('StripeController', () => {
  let controller: StripeController;

  const mockConstructEvent = jest.fn();
  const mockStripeService = {
    stripe: {
      webhooks: {
        constructEvent: mockConstructEvent,
      },
    },
  };

  const mockPaymentService = {
    paymentSucceeded: jest.fn(),
    paymentFailed: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StripeController],
      providers: [
        { provide: StripeService, useValue: mockStripeService },
        { provide: PaymentService, useValue: mockPaymentService },
      ],
    }).compile();

    controller = module.get<StripeController>(StripeController);
    jest.clearAllMocks();
  });

  describe('webhook', () => {
    const mockRequest = {
      rawBody: Buffer.from('mock-raw-body'),
    } as unknown as fastify.FastifyRequest & { rawBody: Buffer };

    it('should verify signature and dispatch payment_intent.succeeded', async () => {
      const mockEvent = {
        type: 'payment_intent.succeeded',
        data: {
          object: { id: 'pi_123', amount: 5000 },
        },
      };

      mockConstructEvent.mockReturnValue(mockEvent);

      const result = await controller.webhook(mockRequest, 'sig-123');

      expect(mockConstructEvent).toHaveBeenCalledWith(
        mockRequest.rawBody,
        'sig-123',
        process.env.STRIPE_WEBHOOK_SECRET,
      );
      expect(mockPaymentService.paymentSucceeded).toHaveBeenCalledWith(
        mockEvent.data.object,
      );
      expect(result).toEqual({ received: true });
    });

    it('should verify signature and dispatch payment_intent.payment_failed', async () => {
      const mockEvent = {
        type: 'payment_intent.payment_failed',
        data: {
          object: { id: 'pi_123', amount: 5000 },
        },
      };

      mockConstructEvent.mockReturnValue(mockEvent);

      const result = await controller.webhook(mockRequest, 'sig-123');

      expect(mockPaymentService.paymentFailed).toHaveBeenCalledWith(
        mockEvent.data.object,
      );
      expect(result).toEqual({ received: true });
    });

    it('should log unhandled event type and return received: true', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const mockEvent = {
        type: 'some.other.event',
      };

      mockConstructEvent.mockReturnValue(mockEvent);

      const result = await controller.webhook(mockRequest, 'sig-123');

      expect(logSpy).toHaveBeenCalledWith('Unhandled event: some.other.event');
      expect(result).toEqual({ received: true });
      logSpy.mockRestore();
    });

    it('should throw an error if constructEvent throws', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Signature mismatch');
      });

      await expect(controller.webhook(mockRequest, 'sig-bad')).rejects.toThrow(
        'Webhook Error: Signature mismatch',
      );
    });
  });
});
