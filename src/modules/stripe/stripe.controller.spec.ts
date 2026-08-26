import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { PaymentService } from '../payments/payment.service';
import { PrismaService } from '@/database/prisma.service';
import * as fastify from 'fastify';

describe('StripeController', () => {
  let controller: StripeController;

  const mockConstructEvent = jest.fn();
  const mockStripeService = {
    stripe: {
      webhooks: { constructEvent: mockConstructEvent },
    },
  };

  const mockPaymentService = {
    handleCheckoutCompleted: jest.fn(),
    handleInvoicePaid: jest.fn(),
    handleInvoicePaymentFailed: jest.fn(),
    handleSubscriptionDeleted: jest.fn(),
    handleChargeRefunded: jest.fn(),
  };

  const mockPrisma = {
    processedStripeEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
  };

  const mockRequest = {
    rawBody: Buffer.from('mock-raw-body'),
  } as unknown as fastify.FastifyRequest & { rawBody: Buffer };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StripeController],
      providers: [
        { provide: StripeService, useValue: mockStripeService },
        { provide: PaymentService, useValue: mockPaymentService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    controller = module.get<StripeController>(StripeController);
    jest.clearAllMocks();
    mockPrisma.processedStripeEvent.findUnique.mockResolvedValue(null);
    mockPrisma.processedStripeEvent.create.mockResolvedValue({});
  });

  it('dispatches checkout.session.completed', async () => {
    const session = { id: 'cs_1' };
    mockConstructEvent.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: session },
    });

    const result = await controller.webhook(mockRequest, 'sig-ok');

    expect(mockPaymentService.handleCheckoutCompleted).toHaveBeenCalledWith(
      session,
    );
    expect(mockPrisma.processedStripeEvent.create).toHaveBeenCalledWith({
      data: { eventId: 'evt_1', eventType: 'checkout.session.completed' },
    });
    expect(result).toEqual({ received: true });
  });

  it('dispatches invoice.paid', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_2',
      type: 'invoice.paid',
      data: { object: { id: 'inv_1' } },
    });

    await controller.webhook(mockRequest, 'sig-ok');
    expect(mockPaymentService.handleInvoicePaid).toHaveBeenCalled();
  });

  it('dispatches invoice.payment_failed', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_3',
      type: 'invoice.payment_failed',
      data: { object: { id: 'inv_2' } },
    });

    await controller.webhook(mockRequest, 'sig-ok');
    expect(mockPaymentService.handleInvoicePaymentFailed).toHaveBeenCalled();
  });

  it('dispatches customer.subscription.deleted', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_4',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1' } },
    });

    await controller.webhook(mockRequest, 'sig-ok');
    expect(mockPaymentService.handleSubscriptionDeleted).toHaveBeenCalled();
  });

  it('dispatches charge.refunded', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_5',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1' } },
    });

    await controller.webhook(mockRequest, 'sig-ok');
    expect(mockPaymentService.handleChargeRefunded).toHaveBeenCalled();
  });

  it('skips already-processed events (idempotency)', async () => {
    mockPrisma.processedStripeEvent.findUnique.mockResolvedValue({
      eventId: 'evt_dup',
    });
    mockConstructEvent.mockReturnValue({
      id: 'evt_dup',
      type: 'checkout.session.completed',
      data: { object: {} },
    });

    const result = await controller.webhook(mockRequest, 'sig-ok');

    expect(result).toEqual({ received: true });
    expect(mockPaymentService.handleCheckoutCompleted).not.toHaveBeenCalled();
    expect(mockPrisma.processedStripeEvent.create).not.toHaveBeenCalled();
  });

  it('returns received: true for unhandled event types', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_x',
      type: 'some.other.event',
      data: { object: {} },
    });

    const result = await controller.webhook(mockRequest, 'sig-ok');
    expect(result).toEqual({ received: true });
  });

  it('throws BadRequestException on signature verification failure', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Signature mismatch');
    });

    await expect(controller.webhook(mockRequest, 'sig-bad')).rejects.toThrow(
      BadRequestException,
    );
  });
});
