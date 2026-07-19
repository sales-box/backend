import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ClientRecord, ClientContext } from './clients.interface';
import { CreateInteractionDto } from './clients.dto';
import { Prisma } from '@prisma/client';
import { PaginationOptions } from '@/database/pagination/pagination.types';
import { ICrmAdapter } from '../crm/crm.interface';
import { CrmAdapterFactory } from '../crm/crm-adapter.factory';

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => CrmAdapterFactory))
    private readonly crmAdapterFactory: CrmAdapterFactory,
  ) {}

  async resolveClientIdentity(
    tenantId: string,
    email: string,
    crmAdapter?: ICrmAdapter | null,
  ): Promise<{
    matchedBy: 'crm' | 'domain' | 'individual';
    existingClientId: string | null;
  }> {
    // 1. CRM check
    if (crmAdapter) {
      try {
        const crmContact = await crmAdapter.getContactByEmail(email);
        if (crmContact && crmContact.id) {
          const matchedClient = await this.prisma.client.findFirst({
            where: { tenantId, crmId: crmContact.id },
          });
          if (matchedClient) {
            return {
              matchedBy: 'crm',
              existingClientId: matchedClient.id,
            };
          }
        }
      } catch (error) {
        this.logger.error(
          `resolveClientIdentity CRM check failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 2. Individual check
    try {
      const matchedClient = await this.prisma.client.findFirst({
        where: { tenantId, email },
      });
      if (matchedClient) {
        return {
          matchedBy: 'individual',
          existingClientId: matchedClient.id,
        };
      }
    } catch (error) {
      this.logger.error(
        `resolveClientIdentity individual check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // 3. Domain check
    const parts = email.split('@');
    const domain = parts.length > 1 ? parts[1].toLowerCase() : null;
    const freeEmails = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    if (domain && !freeEmails.includes(domain)) {
      try {
        const matchedClient = await this.prisma.client.findFirst({
          where: {
            tenantId,
            email: {
              endsWith: `@${domain}`,
            },
          },
        });
        if (matchedClient) {
          return {
            matchedBy: 'domain',
            existingClientId: matchedClient.id,
          };
        }
      } catch (error) {
        this.logger.error(
          `resolveClientIdentity domain check failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      matchedBy: 'individual',
      existingClientId: null,
    };
  }

  async getOrCreateClient(
    tenantId: string,
    email: string,
    name?: string,
    company?: string,
    crmId?: string,
  ): Promise<ClientRecord> {
    const inferredCompany = company || this.inferCompanyFromEmail(email);
    const crmAdapter =
      await this.crmAdapterFactory.getAdapterForTenant(tenantId);
    const resolved = await this.resolveClientIdentity(
      tenantId,
      email,
      crmAdapter,
    );

    if (resolved.existingClientId) {
      const updateData: Prisma.ClientUpdateInput = {};
      if (crmId) {
        updateData.crmId = crmId;
      }
      return this.prisma.client.update({
        where: { id: resolved.existingClientId },
        data: updateData,
      });
    }

    return this.prisma.client.create({
      data: {
        tenantId,
        email,
        name: name || null,
        company: inferredCompany || null,
        crmId: crmId || null,
        status: 'new_inquiry',
      },
    });
  }

  async addInteraction(
    tenantId: string,
    clientId: string,
    data: CreateInteractionDto,
  ) {
    try {
      const client = await this.prisma.client.findFirst({
        where: { id: clientId, tenantId },
      });
      if (!client) {
        throw new NotFoundException(`Client with ID ${clientId} not found`);
      }

      return await this.prisma.interaction.create({
        data: {
          tenantId,
          clientId,
          date: data.date ? new Date(data.date) : new Date(),
          type: data.type,
          subject: data.subject,
          aiSummary: data.aiSummary,
          classification: data.classification || null,
          productConfidence:
            data.productConfidence !== undefined
              ? data.productConfidence
              : null,
          clientHistoryConfidence:
            data.clientHistoryConfidence !== undefined
              ? data.clientHistoryConfidence
              : null,
          recommendation: data.recommendation || null,
        },
      });
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new NotFoundException(`Client with ID ${clientId} not found`);
      }
      throw error;
    }
  }

  async getClient(tenantId: string, id: string) {
    const client = await this.prisma.client.findFirst({
      where: { id, tenantId },
      include: {
        interactions: {
          orderBy: { date: 'desc' },
          take: 20,
        },
      },
    });

    if (!client) {
      throw new NotFoundException(`Client with ID ${id} not found`);
    }

    return client;
  }

  async getClientContext(
    tenantId: string,
    email: string,
  ): Promise<ClientContext> {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      throw new BadRequestException('Client email is invalid or not provided');
    }

    try {
      const crmAdapter =
        await this.crmAdapterFactory.getAdapterForTenant(tenantId);
      const resolved = await this.resolveClientIdentity(
        tenantId,
        email,
        crmAdapter,
      );

      if (!resolved.existingClientId) {
        return {
          isNewClient: true,
          matchedBy: null,
          clientId: null,
          status: 'unknown',
          name: '',
          company: '',
          crmId: null,
          history: [],
        };
      }

      const client = await this.prisma.client.findFirst({
        where: { id: resolved.existingClientId },
        include: {
          interactions: {
            orderBy: { date: 'desc' },
            take: 5,
          },
        },
      });

      if (!client) {
        return {
          isNewClient: true,
          matchedBy: null,
          clientId: null,
          status: 'unknown',
          name: '',
          company: '',
          crmId: null,
          history: [],
        };
      }

      // A 'domain' match means we found a DIFFERENT person at the same
      // company — not this specific client. Their interaction history
      // does not belong to the person we're actually emailing, so treat
      // this as effectively a new (unverified) relationship for
      // confidence purposes, while still surfacing the company-level
      // name/company for display.
      const isEffectivelyNew = resolved.matchedBy === 'domain';

      return {
        isNewClient: isEffectivelyNew,
        matchedBy: resolved.matchedBy,
        clientId: client.id,
        status: client.status,
        name: isEffectivelyNew ? '' : client.name || '',
        company: client.company || '',
        crmId: client.crmId,
        history: isEffectivelyNew
          ? []
          : client.interactions.map((interaction) => ({
              date: interaction.date.toISOString(),
              type: interaction.type,
              subject: interaction.subject,
              summary: interaction.aiSummary,
              classification: interaction.classification,
              recommendation: interaction.recommendation,
            })),
      };
    } catch (error) {
      this.logger.error(error);
      return {
        isNewClient: true,
        matchedBy: null,
        clientId: null,
        status: 'unknown',
        name: '',
        company: '',
        crmId: null,
        history: [],
      };
    }
  }

  async getClients(
    tenantId: string,
    searchQuery?: string,
    options?: PaginationOptions,
  ) {
    const whereClause: Prisma.ClientWhereInput = {
      tenantId,
      ...(searchQuery
        ? {
            OR: [
              { name: { contains: searchQuery, mode: 'insensitive' as const } },
              {
                email: { contains: searchQuery, mode: 'insensitive' as const },
              },
              {
                company: {
                  contains: searchQuery,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };

    return this.prisma.extended.client.paginate(
      {
        where: whereClause,
        orderBy: { createdAt: 'desc' },
      },
      options,
    );
  }

  async getInteractions(
    tenantId: string,
    clientId: string,
    options?: PaginationOptions,
  ) {
    const clientExists = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
    });

    if (!clientExists) {
      throw new NotFoundException(`Client with ID ${clientId} not found`);
    }

    return this.prisma.extended.interaction.paginate(
      {
        where: { clientId, tenantId },
        orderBy: { date: 'desc' },
      },
      options,
    );
  }

  inferCompanyFromEmail(email: string): string {
    const parts = email.split('@');
    if (parts.length < 2) return '';
    const domain = parts[1].toLowerCase();

    const commonProviders = [
      'gmail.com',
      'yahoo.com',
      'hotmail.com',
      'outlook.com',
    ];

    if (commonProviders.includes(domain)) {
      return '';
    }

    const domainParts = domain.split('.');
    if (domainParts.length > 0) {
      const name = domainParts[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    }

    return '';
  }
}
