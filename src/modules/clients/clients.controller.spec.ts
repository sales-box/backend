import { Test, TestingModule } from '@nestjs/testing';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

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

  const tenantId = 'tenant-test-123';

  /** Minimal AuthenticatedRequest stub that satisfies the controller methods. */
  const mockReq = {
    user: { tenantId, isAdmin: true, email: 'admin@example.com', sub: 'acc-1' },
  } as unknown as import('../auth/jwt-auth.guard').AuthenticatedRequest;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClientsController],
      providers: [
        {
          provide: ClientsService,
          useValue: mockClientsService,
        },
      ],
    })
      // Guard logic is tested separately; skip here to keep unit tests fast.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminTenantGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ClientsController>(ClientsController);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('createClient', () => {
    const dto = {
      email: 'test@example.com',
      name: 'Test',
      company: 'Company',
    };

    it('should call service.getOrCreateClient with tenantId from JWT', async () => {
      const expectedResult = {
        id: '1',
        tenantId,
        email: dto.email,
        name: dto.name,
        company: dto.company,
        status: 'new_inquiry',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockClientsService.getOrCreateClient.mockResolvedValue(expectedResult);

      const result = await controller.createClient(mockReq, dto);

      expect(result).toEqual(expectedResult);
      expect(mockClientsService.getOrCreateClient).toHaveBeenCalledWith(
        tenantId,
        dto.email,
        dto.name,
        dto.company,
      );
    });
  });

  describe('addInteraction', () => {
    const clientId = '1';
    const dto = { type: 'email', subject: 'Subject', aiSummary: 'Summary' };

    it('should call service.addInteraction with tenantId from JWT', async () => {
      const expectedResult = { id: 'int-1', tenantId, clientId, ...dto };
      mockClientsService.addInteraction.mockResolvedValue(expectedResult);

      const result = await controller.addInteraction(mockReq, clientId, dto);

      expect(result).toEqual(expectedResult);
      expect(mockClientsService.addInteraction).toHaveBeenCalledWith(
        tenantId,
        clientId,
        dto,
      );
    });
  });

  describe('getClient', () => {
    const clientId = '1';

    it('should call service.getClient with tenantId from JWT', async () => {
      const mockResult = {
        id: clientId,
        tenantId,
        email: 'test@example.com',
        name: 'Test',
        company: 'Company',
        status: 'new_inquiry',
        createdAt: new Date(),
        updatedAt: new Date(),
        interactions: [],
      };
      mockClientsService.getClient.mockResolvedValue(mockResult);

      const result = await controller.getClient(mockReq, clientId);

      expect(result).toEqual(mockResult);
      expect(mockClientsService.getClient).toHaveBeenCalledWith(
        tenantId,
        clientId,
      );
    });
  });

  describe('getClients', () => {
    const query = { search: 'acme', page: 1, limit: 10 };

    it('should call service.getClients with tenantId from JWT and pagination params', async () => {
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

      const result = await controller.getClients(mockReq, query);

      expect(result).toEqual(mockResult);
      expect(mockClientsService.getClients).toHaveBeenCalledWith(
        tenantId,
        query.search,
        {
          page: query.page,
          limit: query.limit,
        },
      );
    });
  });

  describe('getInteractions', () => {
    const clientId = '1';
    const query = { page: 2, limit: 5 };

    it('should call service.getInteractions with tenantId from JWT and pagination params', async () => {
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

      const result = await controller.getInteractions(mockReq, clientId, query);

      expect(result).toEqual(mockResult);
      expect(mockClientsService.getInteractions).toHaveBeenCalledWith(
        tenantId,
        clientId,
        {
          page: query.page,
          limit: query.limit,
        },
      );
    });
  });

  describe('getClientContext', () => {
    const email = 'test@example.com';

    it('should call service.getClientContext with tenantId from JWT and email', async () => {
      const expectedResult = {
        isNewClient: false,
        clientId: 'client-1',
        status: 'active',
        company: 'Stark Industries',
        crmId: 'crm-123',
        history: [],
      };
      mockClientsService.getClientContext.mockResolvedValue(expectedResult);

      const result = await controller.getClientContext(mockReq, email);

      expect(result).toEqual(expectedResult);
      expect(mockClientsService.getClientContext).toHaveBeenCalledWith(
        tenantId,
        email,
      );
    });
  });
});
