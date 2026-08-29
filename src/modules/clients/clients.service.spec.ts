/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { ClientsService } from './clients.service';
import { PrismaService } from '../../database/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('ClientsService', () => {
  let service: ClientsService;

  const mockClientCreate = jest.fn();
  const mockClientFindFirst = jest.fn();
  const mockClientFindUnique = jest.fn();
  const mockClientUpdate = jest.fn();
  const mockClientUpsert = jest.fn();
  const mockInteractionCreate = jest.fn();
  const mockInteractionUpsert = jest.fn();
  const mockTransaction = jest.fn();
  const mockClientPaginate = jest.fn();
  const mockInteractionPaginate = jest.fn();

  beforeEach(async () => {
    const mockPrismaService = {
      client: {
        create: mockClientCreate,
        findFirst: mockClientFindFirst,
        findUnique: mockClientFindUnique,
        update: mockClientUpdate,
        upsert: mockClientUpsert,
      },
      interaction: {
        create: mockInteractionCreate,
        upsert: mockInteractionUpsert,
      },
      extended: {
        client: { paginate: mockClientPaginate },
        interaction: { paginate: mockInteractionPaginate },
      },
      $transaction: mockTransaction,
    };

    mockTransaction.mockImplementation(
      (callback: (tx: typeof mockPrismaService) => unknown) =>
        Promise.resolve(callback(mockPrismaService)),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<ClientsService>(ClientsService);

    jest.clearAllMocks();
    mockTransaction.mockImplementation(
      (callback: (tx: typeof mockPrismaService) => unknown) =>
        Promise.resolve(callback(mockPrismaService)),
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('inferCompanyFromEmail', () => {
    it('should infer company from business email domain', () => {
      expect(service.inferCompanyFromEmail('john@acme.com')).toBe('Acme');
      expect(service.inferCompanyFromEmail('jane@stripe.co')).toBe('Stripe');
    });

    it('should return empty string for common email providers', () => {
      expect(service.inferCompanyFromEmail('john@gmail.com')).toBe('');
      expect(service.inferCompanyFromEmail('jane@yahoo.com')).toBe('');
      expect(service.inferCompanyFromEmail('test@outlook.com')).toBe('');
    });

    it('should return empty string for invalid emails', () => {
      expect(service.inferCompanyFromEmail('notanemail')).toBe('');
    });
  });

  describe('resolveClientIdentity', () => {
    const tenantId = 't-1';
    const email = 'john@acme.com';

    it('normalizes and resolves an exact email before company context', async () => {
      mockClientFindFirst.mockResolvedValueOnce({ id: 'client-exact' });

      const result = await service.resolveClientIdentity(
        tenantId,
        '  JOHN@ACME.COM ',
      );

      expect(result).toEqual({
        matchedBy: 'individual',
        existingClientId: 'client-exact',
      });
      expect(mockClientFindFirst).toHaveBeenCalledWith({
        where: {
          tenantId,
          email: { equals: email, mode: 'insensitive' },
        },
      });
    });

    it('returns a domain match only as company context', async () => {
      mockClientFindFirst
        .mockResolvedValueOnce(null) // no exact person
        .mockResolvedValueOnce({ id: 'client-domain' }); // Domain match

      const result = await service.resolveClientIdentity(tenantId, email);

      expect(result).toEqual({
        matchedBy: 'domain',
        existingClientId: 'client-domain',
      });
      expect(mockClientFindFirst).toHaveBeenCalledTimes(2);
      expect(mockClientFindFirst).toHaveBeenLastCalledWith({
        where: {
          tenantId,
          email: {
            endsWith: '@acme.com',
            mode: 'insensitive',
          },
        },
      });
    });

    it('should skip domain match and fall back to individual match for free emails', async () => {
      const gmailUser = 'john@gmail.com';
      mockClientFindFirst.mockResolvedValueOnce({ id: 'client-gmail' }); // Exact email match

      const result = await service.resolveClientIdentity(tenantId, gmailUser);

      expect(result).toEqual({
        matchedBy: 'individual',
        existingClientId: 'client-gmail',
      });
      expect(mockClientFindFirst).toHaveBeenCalledTimes(1); // Skip domain search, check exact email
      expect(mockClientFindFirst).toHaveBeenCalledWith({
        where: {
          tenantId,
          email: { equals: gmailUser, mode: 'insensitive' },
        },
      });
    });

    it('should return null existingClientId when no match is found', async () => {
      mockClientFindFirst.mockResolvedValue(null); // No domain, no email matches

      const result = await service.resolveClientIdentity(tenantId, email);

      expect(result).toEqual({
        matchedBy: 'individual',
        existingClientId: null,
      });
    });
  });

  describe('getOrCreateClient', () => {
    const tenantId = 't-1';
    const email = 'contact@acme.co';
    const name = 'Acme Support';

    it('should return existing client when resolved', async () => {
      mockClientFindFirst.mockResolvedValueOnce({
        id: 'client-1',
        tenantId,
        email,
      }); // Matches by domain or individual
      mockClientUpdate.mockResolvedValueOnce({
        id: 'client-1',
        tenantId,
        email,
      });

      const result = await service.getOrCreateClient(tenantId, email, name);

      expect(result).toEqual({ id: 'client-1', tenantId, email });
      expect(mockClientCreate).not.toHaveBeenCalled();
      // The name reaches the row now. It used to be dropped on this branch,
      // which left a CRM-known client stuck with whatever their email said.
      expect(mockClientUpdate).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { name },
      });
    });

    it('creates a separate normalized client for a domain-only match', async () => {
      mockClientFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'other-contact' })
        .mockResolvedValueOnce({ company: 'Acme Corporation' });
      const mockResult = {
        id: 'new-client-1',
        tenantId,
        email,
        name,
        company: 'Acme Corporation',
        status: 'new_inquiry',
      };
      mockClientUpsert.mockResolvedValue(mockResult);

      const result = await service.getOrCreateClient(
        tenantId,
        ' CONTACT@ACME.CO ',
        name,
      );

      expect(result).toEqual(mockResult);
      expect(mockClientUpdate).not.toHaveBeenCalled();
      expect(mockClientUpsert).toHaveBeenCalledWith({
        where: { tenantId_email: { tenantId, email } },
        create: {
          tenantId,
          email,
          name,
          company: 'Acme Corporation',
          crmId: null,
          status: 'new_inquiry',
        },
        update: { name },
      });
    });

    it('creates with the status the CRM supplied, not the default', async () => {
      mockClientFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockClientUpsert.mockResolvedValue({ id: 'new-client-2' });

      await service.getOrCreateClient(
        tenantId,
        email,
        name,
        'Acme',
        'crm-9',
        'customer',
      );

      expect(mockClientUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'customer' }),
          update: expect.objectContaining({ status: 'customer' }),
        }),
      );
    });

    it('starts a client with no CRM opinion as a new inquiry', async () => {
      mockClientFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockClientUpsert.mockResolvedValue({ id: 'new-client-4' });

      await service.getOrCreateClient(tenantId, email, name, 'Acme', 'crm-9');

      expect(mockClientUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'new_inquiry' }),
        }),
      );
    });

    it('upgrades an already-known client when the CRM moved them on', async () => {
      mockClientFindFirst.mockResolvedValueOnce({
        id: 'client-1',
        tenantId,
        email,
      });
      mockClientUpdate.mockResolvedValueOnce({ id: 'client-1' });

      await service.getOrCreateClient(
        tenantId,
        email,
        undefined,
        undefined,
        'crm-9',
        'opportunity',
      );

      expect(mockClientUpdate).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { crmId: 'crm-9', status: 'opportunity' },
      });
    });

    // The CRM's name and company were discarded on this branch, so a client the
    // CRM already knew kept the display name off their email and a null company
    // for ever. Seen live: Zoho held "Hamada Loksha / Delta Industrial Park"
    // while the row read "hamoksha eloksha" with no company.
    it('refreshes name and company on an already-known client', async () => {
      mockClientFindFirst.mockResolvedValueOnce({
        id: 'client-1',
        tenantId,
        email,
      });
      mockClientUpdate.mockResolvedValueOnce({ id: 'client-1' });

      await service.getOrCreateClient(
        tenantId,
        email,
        'Hamada Loksha',
        'Delta Industrial Park',
        'crm-9',
        'qualified',
      );

      expect(mockClientUpdate).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: {
          crmId: 'crm-9',
          status: 'qualified',
          name: 'Hamada Loksha',
          company: 'Delta Industrial Park',
        },
      });
    });

    // A provider that sends nothing must not blank a good local value.
    it('does not wipe name or company when the CRM sends neither', async () => {
      mockClientFindFirst.mockResolvedValueOnce({
        id: 'client-1',
        tenantId,
        email,
      });
      mockClientUpdate.mockResolvedValueOnce({ id: 'client-1' });

      await service.getOrCreateClient(
        tenantId,
        email,
        undefined,
        undefined,
        'crm-9',
      );

      expect(mockClientUpdate).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { crmId: 'crm-9' },
      });
    });

    it('leaves an existing status alone when the CRM has no opinion', async () => {
      mockClientFindFirst.mockResolvedValueOnce({
        id: 'client-1',
        tenantId,
        email,
      });
      mockClientUpdate.mockResolvedValueOnce({ id: 'client-1' });

      await service.getOrCreateClient(
        tenantId,
        email,
        undefined,
        undefined,
        'crm-9',
      );

      expect(mockClientUpdate).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { crmId: 'crm-9' },
      });
    });
  });

  describe('captureInboundEmail', () => {
    const tenantId = 'tenant-1';
    const baseInput = {
      messageId: 'message-1',
      senderEmail: ' Prospect@Acme.com ',
      senderName: 'Pat Prospect',
      date: '1720000000000',
      subject: 'Pricing question',
    };

    it('creates an exact normalized client and the first inbound interaction', async () => {
      mockClientFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockClientUpsert.mockResolvedValue({ id: 'client-1' });
      mockInteractionUpsert.mockResolvedValue({ id: 'interaction-1' });

      await service.captureInboundEmail(tenantId, baseInput);

      expect(mockClientUpsert).toHaveBeenCalledWith({
        where: {
          tenantId_email: { tenantId, email: 'prospect@acme.com' },
        },
        create: {
          tenantId,
          email: 'prospect@acme.com',
          name: 'Pat Prospect',
          company: 'Acme',
          status: 'new_inquiry',
        },
        update: { name: 'Pat Prospect' },
      });
      expect(mockInteractionUpsert).toHaveBeenCalledWith({
        where: {
          tenant_message: { tenantId, messageId: 'message-1' },
        },
        create: expect.objectContaining({
          tenantId,
          clientId: 'client-1',
          messageId: 'message-1',
          date: new Date(1720000000000),
          type: 'inbound',
          subject: 'Pricing question',
        }),
        update: {},
      });
    });

    it('keeps same-domain contacts separate while reusing company context', async () => {
      mockClientFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ company: 'Acme Corporation' });
      mockClientUpsert.mockResolvedValue({ id: 'new-person' });
      mockInteractionUpsert.mockResolvedValue({ id: 'interaction-1' });

      await service.captureInboundEmail(tenantId, baseInput);

      expect(mockClientUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_email: { tenantId, email: 'prospect@acme.com' },
          },
          create: expect.objectContaining({ company: 'Acme Corporation' }),
        }),
      );
    });

    it('does not infer or share a company for free-mail addresses', async () => {
      mockClientFindFirst.mockResolvedValueOnce(null);
      mockClientUpsert.mockResolvedValue({ id: 'gmail-client' });
      mockInteractionUpsert.mockResolvedValue({ id: 'interaction-1' });

      await service.captureInboundEmail(tenantId, {
        ...baseInput,
        senderEmail: 'person@gmail.com',
      });

      expect(mockClientFindFirst).toHaveBeenCalledTimes(1);
      expect(mockClientUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ company: null }),
        }),
      );
    });

    it('is idempotent and never replaces analysis with blank retry data', async () => {
      mockClientFindFirst.mockResolvedValue({
        id: 'client-1',
        name: 'Pat Prospect',
      });
      mockClientUpdate.mockResolvedValue({ id: 'client-1' });
      mockInteractionUpsert.mockResolvedValue({ id: 'interaction-1' });

      await service.captureInboundEmail(tenantId, {
        ...baseInput,
        aiSummary: 'Pricing request',
        classification: 'product inquiry',
        productConfidence: 0.8,
      });
      await service.captureInboundEmail(tenantId, {
        ...baseInput,
        aiSummary: '',
        classification: null,
      });

      expect(mockInteractionUpsert).toHaveBeenCalledTimes(2);
      expect(mockInteractionUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ update: {} }),
      );
    });

    it('retries one concurrent unique-key race in a fresh transaction', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint',
        { code: 'P2002', clientVersion: '6.19.3' },
      );
      mockTransaction.mockRejectedValueOnce(p2002);
      mockClientFindFirst.mockResolvedValue({
        id: 'race-winner-client',
        name: 'Pat Prospect',
      });
      mockClientUpdate.mockResolvedValue({ id: 'race-winner-client' });
      mockInteractionUpsert.mockResolvedValue({
        id: 'race-winner-interaction',
      });

      const result = await service.captureInboundEmail(tenantId, baseInput);

      expect(mockTransaction).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        client: { id: 'race-winner-client' },
        interaction: { id: 'race-winner-interaction' },
      });
    });

    it('attaches a second message to the same exact client', async () => {
      mockClientFindFirst.mockResolvedValue({
        id: 'client-1',
        name: 'Pat Prospect',
      });
      mockClientUpdate.mockResolvedValue({ id: 'client-1' });
      mockInteractionUpsert.mockResolvedValue({ id: 'interaction-2' });

      await service.captureInboundEmail(tenantId, {
        ...baseInput,
        messageId: 'message-2',
      });

      expect(mockClientUpsert).not.toHaveBeenCalled();
      expect(mockInteractionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenant_message: { tenantId, messageId: 'message-2' },
          },
          create: expect.objectContaining({ clientId: 'client-1' }),
        }),
      );
    });

    it('scopes both identity and idempotency keys to the tenant', async () => {
      mockClientFindFirst.mockResolvedValue({
        id: 'tenant-client',
        name: null,
      });
      mockClientUpdate.mockResolvedValue({ id: 'tenant-client' });
      mockInteractionUpsert.mockResolvedValue({ id: 'interaction-1' });

      await service.captureInboundEmail('tenant-2', baseInput);

      expect(mockClientFindFirst).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-2',
          email: { equals: 'prospect@acme.com', mode: 'insensitive' },
        },
      });
      expect(mockInteractionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenant_message: {
              tenantId: 'tenant-2',
              messageId: 'message-1',
            },
          },
        }),
      );
    });

    it('validates identity keys and safely falls back for invalid dates', async () => {
      await expect(
        service.captureInboundEmail(tenantId, {
          ...baseInput,
          messageId: ' ',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.captureInboundEmail(tenantId, {
          ...baseInput,
          senderEmail: 'not-an-email',
        }),
      ).rejects.toThrow(BadRequestException);

      mockClientFindFirst.mockResolvedValue({ id: 'client-1', name: null });
      mockClientUpdate.mockResolvedValue({ id: 'client-1' });
      mockInteractionUpsert.mockResolvedValue({ id: 'interaction-1' });
      const before = Date.now();
      await service.captureInboundEmail(tenantId, {
        ...baseInput,
        date: 'not-a-date',
      });
      const firstCall = mockInteractionUpsert.mock.calls.at(0) as unknown as
        [{ create: { date: Date } }] | undefined;
      const capturedDate = firstCall?.[0].create.date;
      expect(capturedDate).toBeDefined();
      if (!capturedDate) throw new Error('Interaction was not captured');
      expect(capturedDate.getTime()).toBeGreaterThanOrEqual(before);
      expect(capturedDate.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('addInteraction', () => {
    const tenantId = 't-1';
    const clientId = 'client-1';

    it('should insert a new interaction linked to a client under correct tenant', async () => {
      mockClientFindFirst.mockResolvedValueOnce({ id: clientId, tenantId });
      const dto = {
        type: 'email',
        subject: 'Inquiry',
        aiSummary: 'Interested in product pricing.',
        classification: 'pricing',
        productConfidence: 0.95,
        clientHistoryConfidence: 0.8,
        recommendation: 'Send sales deck',
      };
      const mockResult = {
        id: 'interaction-1',
        tenantId,
        clientId,
        date: new Date(),
        ...dto,
        createdAt: new Date(),
      };
      mockInteractionCreate.mockResolvedValue(mockResult);

      const result = await service.addInteraction(tenantId, clientId, dto);

      expect(result).toEqual(mockResult);
      expect(mockInteractionCreate).toHaveBeenCalledWith({
        data: {
          tenantId,
          clientId,
          date: expect.any(Date),
          type: dto.type,
          subject: dto.subject,
          aiSummary: dto.aiSummary,
          classification: dto.classification,
          productConfidence: dto.productConfidence,
          clientHistoryConfidence: dto.clientHistoryConfidence,
          recommendation: dto.recommendation,
        },
      });
    });

    it('should throw NotFoundException if client does not belong to the tenant', async () => {
      mockClientFindFirst.mockResolvedValueOnce(null); // Not found under this tenant

      await expect(
        service.addInteraction(tenantId, clientId, {
          type: 'email',
          subject: 'X',
          aiSummary: 'Y',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getClient', () => {
    const tenantId = 't-1';
    const clientId = 'client-1';

    it('should return client under the tenant with interactions', async () => {
      const mockClient = {
        id: clientId,
        tenantId,
        email: 'john@acme.co',
        name: 'John',
        company: 'Acme',
        status: 'new_inquiry',
        createdAt: new Date(),
        updatedAt: new Date(),
        interactions: [],
      };

      mockClientFindFirst.mockResolvedValue(mockClient);

      const result = await service.getClient(tenantId, clientId);

      expect(result).toEqual(mockClient);
      expect(mockClientFindFirst).toHaveBeenCalledWith({
        where: { id: clientId, tenantId },
        include: {
          interactions: {
            orderBy: { date: 'desc' },
            take: 20,
          },
        },
      });
    });

    it('should throw NotFoundException if client does not exist under tenant', async () => {
      mockClientFindFirst.mockResolvedValue(null);

      await expect(service.getClient(tenantId, 'non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getClientContext', () => {
    const tenantId = 't-1';

    it('should throw BadRequestException if email is invalid or empty', async () => {
      await expect(service.getClientContext(tenantId, '')).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.getClientContext(tenantId, 'not-an-email'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return default context if client is not found in database', async () => {
      mockClientFindFirst.mockResolvedValue(null);

      const result = await service.getClientContext(
        tenantId,
        'new-user@example.com',
      );

      expect(result).toEqual({
        isNewClient: true,
        matchedBy: null,
        clientId: null,
        status: 'unknown',
        name: '',
        company: '',
        crmId: null,
        historyCount: 0,
        history: [],
      });
      // Verification of identity resolution calls
      expect(mockClientFindFirst).toHaveBeenCalledWith({
        where: {
          tenantId,
          email: {
            endsWith: '@example.com',
            mode: 'insensitive',
          },
        },
      });
    });

    it('treats a captured first email as new and excludes it from prior history', async () => {
      const firstContact = {
        id: 'client-first',
        tenantId,
        email: 'first@example.com',
        name: 'First Contact',
        company: 'Example',
        status: 'new_inquiry',
        crmId: null,
        interactions: [],
        _count: { interactions: 0 },
      };
      mockClientFindFirst.mockResolvedValue(firstContact);

      const result = await service.getClientContext(
        tenantId,
        ' FIRST@example.com ',
        'current-message',
      );

      expect(result).toEqual(
        expect.objectContaining({
          isNewClient: true,
          clientId: 'client-first',
          name: 'First Contact',
          historyCount: 0,
          history: [],
        }),
      );
      const priorHistoryWhere = {
        OR: [{ messageId: null }, { messageId: { not: 'current-message' } }],
      };
      expect(mockClientFindFirst).toHaveBeenLastCalledWith({
        where: { id: 'client-first', tenantId },
        include: {
          interactions: {
            where: priorHistoryWhere,
            orderBy: { date: 'desc' },
            take: 5,
          },
          _count: {
            select: { interactions: { where: priorHistoryWhere } },
          },
        },
      });
    });

    it('keeps an exact CRM client known even with no prior interactions', async () => {
      mockClientFindFirst.mockResolvedValue({
        id: 'crm-client',
        tenantId,
        email: 'crm@example.com',
        name: 'CRM Contact',
        company: 'Example',
        status: 'unknown',
        crmId: 'crm-1',
        interactions: [],
        _count: { interactions: 0 },
      });

      const result = await service.getClientContext(
        tenantId,
        'crm@example.com',
        'current-message',
      );

      expect(result.isNewClient).toBe(false);
      expect(result.clientId).toBe('crm-client');
    });

    it('should return up to 5 interactions but the TOTAL count alongside them', async () => {
      const mockInteractions = Array.from({ length: 7 }, (_, i) => ({
        id: `int-${i}`,
        date: new Date(`2026-07-08T10:0${i}:00.000Z`),
        type: 'email',
        subject: `Subject ${i}`,
        aiSummary: `Summary ${i}`,
        classification: `class-${i}`,
        recommendation: `rec-${i}`,
      }));

      const mockClient = {
        id: 'client-123',
        tenantId,
        email: 'client@example.com',
        name: 'John Doe',
        company: 'Stark Industries',
        status: 'active',
        crmId: 'crm-789',
        createdAt: new Date(),
        updatedAt: new Date(),
        interactions: mockInteractions.slice(0, 5),
        // Prisma returns the real total here even though the array above is
        // truncated — the Supervisor grades on this, not on array length.
        _count: { interactions: mockInteractions.length },
      };

      mockClientFindFirst.mockResolvedValue(mockClient);

      const result = await service.getClientContext(
        tenantId,
        'client@example.com',
      );

      expect(result).toEqual({
        isNewClient: false,
        matchedBy: 'individual',
        clientId: 'client-123',
        status: 'active',
        name: 'John Doe',
        company: 'Stark Industries',
        crmId: 'crm-789',
        // 7, not the 5 rows actually returned
        historyCount: 7,
        history: mockInteractions.slice(0, 5).map((item) => ({
          date: item.date.toISOString(),
          type: item.type,
          subject: item.subject,
          summary: item.aiSummary,
          classification: item.classification,
          recommendation: item.recommendation,
        })),
      });
    });

    it('should return mapped client context for domain match (effectively new client with empty name and history)', async () => {
      const mockInteractions = Array.from({ length: 3 }, (_, i) => ({
        id: `int-${i}`,
        date: new Date(`2026-07-08T10:0${i}:00.000Z`),
        type: 'email',
        subject: `Subject ${i}`,
        aiSummary: `Summary ${i}`,
        classification: `class-${i}`,
        recommendation: `rec-${i}`,
      }));

      const mockClient = {
        id: 'client-company-matched',
        tenantId,
        email: 'another@acme.com',
        name: 'Alice Smith',
        company: 'Acme Corp',
        status: 'active',
        crmId: 'other-crm-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        interactions: mockInteractions,
        _count: { interactions: mockInteractions.length },
      };

      mockClientFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockClient)
        .mockResolvedValueOnce(mockClient);

      const result = await service.getClientContext(
        tenantId,
        'newperson@acme.com',
      );

      expect(result).toEqual({
        isNewClient: true,
        matchedBy: 'domain',
        clientId: null,
        status: 'unknown',
        name: '',
        company: 'Acme Corp',
        crmId: null,
        // Zeroed with the array it summarises — those 3 interactions belong to
        // Alice, not to the person we're actually emailing.
        historyCount: 0,
        history: [],
      });
    });
  });
});
