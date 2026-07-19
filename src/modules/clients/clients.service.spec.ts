/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ClientsService } from './clients.service';
import { PrismaService } from '../../database/prisma.service';
import { CrmAdapterFactory } from '../crm/crm-adapter.factory';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ICrmAdapter } from '../crm/crm.interface';

describe('ClientsService', () => {
  let service: ClientsService;

  const mockClientCreate = jest.fn();
  const mockClientFindFirst = jest.fn();
  const mockClientFindUnique = jest.fn();
  const mockClientUpdate = jest.fn();
  const mockInteractionCreate = jest.fn();
  const mockClientPaginate = jest.fn();
  const mockInteractionPaginate = jest.fn();

  const mockCrmAdapter: jest.Mocked<ICrmAdapter> = {
    syncContact: jest.fn(),
    createOrUpdateDeal: jest.fn(),
    logEngagementNote: jest.fn(),
    getContactByEmail: jest.fn(),
    fetchContacts: jest.fn(),
  };

  const mockCrmAdapterFactory = {
    getAdapterForTenant: jest.fn().mockResolvedValue(mockCrmAdapter),
  };

  beforeEach(async () => {
    const mockPrismaService = {
      client: {
        create: mockClientCreate,
        findFirst: mockClientFindFirst,
        findUnique: mockClientFindUnique,
        update: mockClientUpdate,
      },
      interaction: {
        create: mockInteractionCreate,
      },
      extended: {
        client: { paginate: mockClientPaginate },
        interaction: { paginate: mockInteractionPaginate },
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: CrmAdapterFactory,
          useValue: mockCrmAdapterFactory,
        },
      ],
    }).compile();

    service = module.get<ClientsService>(ClientsService);

    jest.clearAllMocks();
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

    it('should resolve by CRM contact ID when matching client exists in DB', async () => {
      mockCrmAdapter.getContactByEmail.mockResolvedValue({
        id: 'crm-contact-123',
      });
      mockClientFindFirst.mockResolvedValueOnce({ id: 'client-crm' }); // Client with matched crmId

      const result = await service.resolveClientIdentity(
        tenantId,
        email,
        mockCrmAdapter,
      );

      expect(result).toEqual({
        matchedBy: 'crm',
        existingClientId: 'client-crm',
      });
      expect(mockCrmAdapter.getContactByEmail).toHaveBeenCalledWith(email);
      expect(mockClientFindFirst).toHaveBeenCalledWith({
        where: { tenantId, crmId: 'crm-contact-123' },
      });
    });

    it('should fall back to Domain check if CRM contact has no match in DB', async () => {
      mockCrmAdapter.getContactByEmail.mockResolvedValue({
        id: 'crm-contact-123',
      });
      mockClientFindFirst
        .mockResolvedValueOnce(null) // no CRM-ID match in DB
        .mockResolvedValueOnce(null) // no Individual match in DB
        .mockResolvedValueOnce({ id: 'client-domain' }); // Domain match

      const result = await service.resolveClientIdentity(
        tenantId,
        email,
        mockCrmAdapter,
      );

      expect(result).toEqual({
        matchedBy: 'domain',
        existingClientId: 'client-domain',
      });
      expect(mockClientFindFirst).toHaveBeenCalledTimes(3);
      expect(mockClientFindFirst).toHaveBeenLastCalledWith({
        where: {
          tenantId,
          email: {
            endsWith: '@acme.com',
          },
        },
      });
    });

    it('should skip domain match and fall back to individual match for free emails', async () => {
      const gmailUser = 'john@gmail.com';
      mockCrmAdapter.getContactByEmail.mockResolvedValue(null);
      mockClientFindFirst.mockResolvedValueOnce({ id: 'client-gmail' }); // Exact email match

      const result = await service.resolveClientIdentity(
        tenantId,
        gmailUser,
        mockCrmAdapter,
      );

      expect(result).toEqual({
        matchedBy: 'individual',
        existingClientId: 'client-gmail',
      });
      expect(mockClientFindFirst).toHaveBeenCalledTimes(1); // Skip domain search, check exact email
      expect(mockClientFindFirst).toHaveBeenCalledWith({
        where: { tenantId, email: gmailUser },
      });
    });

    it('should return null existingClientId when no match is found', async () => {
      mockCrmAdapter.getContactByEmail.mockResolvedValue(null);
      mockClientFindFirst.mockResolvedValue(null); // No domain, no email matches

      const result = await service.resolveClientIdentity(
        tenantId,
        email,
        mockCrmAdapter,
      );

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
      mockCrmAdapter.getContactByEmail.mockResolvedValue(null);
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
      expect(mockClientUpdate).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: {},
      });
    });

    it('should create new client when not resolved', async () => {
      mockCrmAdapter.getContactByEmail.mockResolvedValue(null);
      mockClientFindFirst.mockResolvedValue(null);
      const mockResult = {
        id: 'new-client-1',
        tenantId,
        email,
        name,
        company: 'Acme',
        status: 'new_inquiry',
      };
      mockClientCreate.mockResolvedValue(mockResult);

      const result = await service.getOrCreateClient(tenantId, email, name);

      expect(result).toEqual(mockResult);
      expect(mockClientCreate).toHaveBeenCalledWith({
        data: {
          tenantId,
          email,
          name,
          company: 'Acme',
          crmId: null,
          status: 'new_inquiry',
        },
      });
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
        history: [],
      });
      // Verification of identity resolution calls
      expect(mockClientFindFirst).toHaveBeenCalledWith({
        where: {
          tenantId,
          email: {
            endsWith: '@example.com',
          },
        },
      });
    });

    it('should return mapped client context with up to 5 interactions if client exists', async () => {
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
        crmId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        interactions: mockInteractions,
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
        clientId: 'client-company-matched',
        status: 'active',
        name: '',
        company: 'Acme Corp',
        crmId: null,
        history: [],
      });
    });
  });
});
