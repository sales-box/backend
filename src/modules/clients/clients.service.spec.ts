/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { ClientsService } from './clients.service';
import { PrismaService } from '../../database/prisma.service';
import { NotFoundException } from '@nestjs/common';

describe('ClientsService', () => {
  let service: ClientsService;

  const mockClientUpsert = jest.fn();
  const mockInteractionCreate = jest.fn();
  const mockClientFindUnique = jest.fn();

  beforeEach(async () => {
    const mockPrismaService = {
      client: {
        upsert: mockClientUpsert,
        findUnique: mockClientFindUnique,
      },
      interaction: {
        create: mockInteractionCreate,
      },
    };

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

  describe('getOrCreateClient', () => {
    it('should create client via upsert with inferred company', async () => {
      const email = 'contact@acme.co';
      const name = 'Acme Support';
      const mockResult = {
        id: 'client-1',
        email,
        name,
        company: 'Acme',
        status: 'new_inquiry',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockClientUpsert.mockResolvedValue(mockResult);

      const result = await service.getOrCreateClient(email, name);

      expect(result).toEqual(mockResult);
      expect(mockClientUpsert).toHaveBeenCalledWith({
        where: { email },
        update: {},
        create: {
          email,
          name,
          company: 'Acme',
          status: 'new_inquiry',
        },
      });
    });

    it('should prioritize passed company over inferred company', async () => {
      const email = 'contact@acme.co';
      const name = 'Acme Support';
      const passedCompany = 'Acme Corporation';
      const mockResult = {
        id: 'client-1',
        email,
        name,
        company: passedCompany,
        status: 'new_inquiry',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockClientUpsert.mockResolvedValue(mockResult);

      const result = await service.getOrCreateClient(
        email,
        name,
        passedCompany,
      );

      expect(result).toEqual(mockResult);
      expect(mockClientUpsert).toHaveBeenCalledWith({
        where: { email },
        update: {},
        create: {
          email,
          name,
          company: passedCompany,
          status: 'new_inquiry',
        },
      });
    });
  });

  describe('addInteraction', () => {
    it('should insert a new interaction linked to a client', async () => {
      const clientId = 'client-1';
      const dto = {
        type: 'email',
        subject: 'Inquiry',
        aiSummary: 'Interested in product pricing.',
        classification: 'pricing',
        confidence: 0.95,
        recommendation: 'Send sales deck',
      };
      const mockResult = {
        id: 'interaction-1',
        clientId,
        date: new Date(),
        ...dto,
        createdAt: new Date(),
      };
      mockInteractionCreate.mockResolvedValue(mockResult);

      const result = await service.addInteraction(clientId, dto);

      expect(result).toEqual(mockResult);
      expect(mockInteractionCreate).toHaveBeenCalledWith({
        data: {
          clientId,
          date: expect.any(Date),
          type: dto.type,
          subject: dto.subject,
          aiSummary: dto.aiSummary,
          classification: dto.classification,
          confidence: dto.confidence,
          recommendation: dto.recommendation,
        },
      });
    });
  });

  describe('getClient', () => {
    it('should return client with limited/sorted interactions', async () => {
      const clientId = 'client-1';
      const mockClient = {
        id: clientId,
        email: 'john@acme.co',
        name: 'John',
        company: 'Acme',
        status: 'new_inquiry',
        createdAt: new Date(),
        updatedAt: new Date(),
        interactions: Array.from({ length: 25 }, (_, i) => ({
          id: `interaction-${i}`,
          date: new Date(Date.now() - i * 1000),
          type: 'email',
          subject: `Subject ${i}`,
          aiSummary: `Summary ${i}`,
        })).slice(0, 20),
      };

      mockClientFindUnique.mockResolvedValue(mockClient);

      const result = await service.getClient(clientId);

      expect(result).toEqual(mockClient);
      expect(result.interactions).toHaveLength(20);
      expect(mockClientFindUnique).toHaveBeenCalledWith({
        where: { id: clientId },
        include: {
          interactions: {
            orderBy: { date: 'desc' },
            take: 20,
          },
        },
      });
    });

    it('should throw NotFoundException if client does not exist', async () => {
      mockClientFindUnique.mockResolvedValue(null);

      await expect(service.getClient('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
