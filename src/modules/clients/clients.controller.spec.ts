import { Test, TestingModule } from '@nestjs/testing';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

describe('ClientsController', () => {
  let controller: ClientsController;

  const mockClientsService = {
    getOrCreateClient: jest.fn(),
    addInteraction: jest.fn(),
    getClient: jest.fn(),
    getClients: jest.fn(),
    getInteractions: jest.fn(),
    getClientContext: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClientsController],
      providers: [
        {
          provide: ClientsService,
          useValue: mockClientsService,
        },
      ],
    }).compile();

    controller = module.get<ClientsController>(ClientsController);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('createClient', () => {
    it('should call service.getOrCreateClient', async () => {
      const dto = {
        email: 'test@example.com',
        name: 'Test',
        company: 'Company',
      };
      const expectedResult = {
        id: '1',
        email: dto.email,
        name: dto.name,
        company: dto.company,
        status: 'new_inquiry',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockClientsService.getOrCreateClient.mockResolvedValue(expectedResult);

      const result = await controller.createClient(dto);

      expect(result).toEqual(expectedResult);
      expect(mockClientsService.getOrCreateClient).toHaveBeenCalledWith(
        dto.email,
        dto.name,
        dto.company,
      );
    });
  });

  describe('addInteraction', () => {
    it('should call service.addInteraction', async () => {
      const clientId = '1';
      const dto = { type: 'email', subject: 'Subject', aiSummary: 'Summary' };
      const expectedResult = { id: 'int-1', clientId, ...dto };
      mockClientsService.addInteraction.mockResolvedValue(expectedResult);

      const result = await controller.addInteraction(clientId, dto);

      expect(result).toEqual(expectedResult);
      expect(mockClientsService.addInteraction).toHaveBeenCalledWith(
        clientId,
        dto,
      );
    });
  });

  describe('getClient', () => {
    it('should call service.getClient', async () => {
      const clientId = '1';
      const mockResult = {
        id: clientId,
        email: 'test@example.com',
        name: 'Test',
        company: 'Company',
        status: 'new_inquiry',
        createdAt: new Date(),
        updatedAt: new Date(),
        interactions: [],
      };
      mockClientsService.getClient.mockResolvedValue(mockResult);

      const result = await controller.getClient(clientId);

      expect(result).toEqual(mockResult);
      expect(mockClientsService.getClient).toHaveBeenCalledWith(clientId);
    });
  });

  describe('getClients', () => {
    it('should call service.getClients with search and pagination params', async () => {
      const query = { search: 'acme', page: 1, limit: 10 };
      const mockResult = {
        data: [],
        meta: {
          total: 0,
          lastPage: 1,
          currentPage: 1,
          limit: 10,
          prev: null,
          next: null,
        },
      };
      mockClientsService.getClients.mockResolvedValue(mockResult);

      const result = await controller.getClients(query);

      expect(result).toEqual(mockResult);
      expect(mockClientsService.getClients).toHaveBeenCalledWith(query.search, {
        page: query.page,
        limit: query.limit,
      });
    });
  });

  describe('getInteractions', () => {
    it('should call service.getInteractions with pagination params', async () => {
      const clientId = '1';
      const query = { page: 2, limit: 5 };
      const mockResult = {
        data: [],
        meta: {
          total: 10,
          lastPage: 2,
          currentPage: 2,
          limit: 5,
          prev: 1,
          next: null,
        },
      };
      mockClientsService.getInteractions.mockResolvedValue(mockResult);

      const result = await controller.getInteractions(clientId, query);

      expect(result).toEqual(mockResult);
      expect(mockClientsService.getInteractions).toHaveBeenCalledWith(
        clientId,
        {
          page: query.page,
          limit: query.limit,
        },
      );
    });
  });

  describe('getClientContext', () => {
    it('should call service.getClientContext with query email parameter', async () => {
      const email = 'test@example.com';
      const expectedResult = {
        isNewClient: false,
        clientId: 'client-1',
        status: 'active',
        company: 'Stark Industries',
        crmId: 'crm-123',
        history: [],
      };
      mockClientsService.getClientContext.mockResolvedValue(expectedResult);

      const result = await controller.getClientContext(email);

      expect(result).toEqual(expectedResult);
      expect(mockClientsService.getClientContext).toHaveBeenCalledWith(email);
    });
  });
});
