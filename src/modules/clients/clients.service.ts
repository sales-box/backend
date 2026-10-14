import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  CaptureInboundEmailInput,
  ClientRecord,
  ClientContext,
} from './clients.interface';
import { type ClientStatus, DEFAULT_CLIENT_STATUS } from './client-status';
import { CreateInteractionDto } from './clients.dto';
import { Prisma } from '@prisma/client';
import { PaginationOptions } from '@/database/pagination/pagination.types';

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveClientIdentity(
    tenantId: string,
    email: string,
  ): Promise<{
    matchedBy: 'domain' | 'individual';
    existingClientId: string | null;
  }> {
    const normalizedEmail = this.normalizeEmail(email);

    // Exact email is the only person-level identity key. CRM IDs and company
    // domains may enrich that person, but never merge a different address.
    try {
      const matchedClient = await this.prisma.client.findFirst({
        where: {
          tenantId,
          email: { equals: normalizedEmail, mode: 'insensitive' },
        },
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

    // A domain match is company context only. Callers must never treat this ID
    // as the sender's person record.
    const parts = normalizedEmail.split('@');
    const domain = parts.length > 1 ? parts[1].toLowerCase() : null;
    const freeEmails = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    if (domain && !freeEmails.includes(domain)) {
      try {
        const matchedClient = await this.prisma.client.findFirst({
          where: {
            tenantId,
            email: {
              endsWith: `@${domain}`,
              mode: 'insensitive',
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

  /**
   * `status` is the CRM's view of where this client sits. It is optional and
   * only ever written when supplied: a CRM that has no opinion, or one using a
   * lifecycle stage we do not recognise, must not knock a client back down to
   * `new_inquiry` on every reconnect.
   */
  async getOrCreateClient(
    tenantId: string,
    email: string,
    name?: string,
    company?: string,
    crmId?: string,
    status?: ClientStatus,
  ): Promise<ClientRecord> {
    const normalizedEmail = this.normalizeEmail(email);
    const resolved = await this.resolveClientIdentity(
      tenantId,
      normalizedEmail,
    );

    if (resolved.matchedBy === 'individual' && resolved.existingClientId) {
      const updateData: Prisma.ClientUpdateInput = {};
      if (crmId) {
        updateData.crmId = crmId;
      }
      if (status) {
        updateData.status = status;
      }
      // The CRM's name and company were being discarded here, so a client the
      // CRM already knew — one whose email arrived before the first sync — kept
      // the display name off the email and a null company for ever. Observed on
      // 29 Aug: Zoho held "Hamada Loksha / Delta Industrial Park" while the row
      // read "hamoksha eloksha" with no company. Guarded on truthiness so a
      // provider that sends nothing cannot blank a good local value, which is
      // the same rule the upsert's update branch below already follows.
      if (name) {
        updateData.name = name;
      }
      if (company) {
        updateData.company = company;
      }
      return this.prisma.client.update({
        where: { id: resolved.existingClientId },
        data: updateData,
      });
    }

    const domainCompany = resolved.existingClientId
      ? await this.prisma.client.findFirst({
          where: { id: resolved.existingClientId, tenantId },
          select: { company: true },
        })
      : null;
    const inferredCompany =
      company ||
      domainCompany?.company ||
      this.inferCompanyFromEmail(normalizedEmail);

    return this.prisma.client.upsert({
      where: { tenantId_email: { tenantId, email: normalizedEmail } },
      create: {
        tenantId,
        email: normalizedEmail,
        name: name || null,
        company: inferredCompany || null,
        crmId: crmId || null,
        // A client with no interactions or history yet is new. Only a real
        // signal — a CRM lifecycle stage here — moves them off that.
        status: status ?? DEFAULT_CLIENT_STATUS,
      },
      update: {
        ...(name ? { name } : {}),
        ...(company ? { company } : {}),
        ...(crmId ? { crmId } : {}),
        ...(status ? { status } : {}),
      },
    });
  }

  /**
   * Persists an incoming email before any AI work starts. Both the background
   * worker and on-demand endpoint call this method; the database keys make the
   * operation safe when they race.
   */
  async captureInboundEmail(tenantId: string, input: CaptureInboundEmailInput) {
    const normalizedEmail = this.normalizeEmail(input.senderEmail);
    const messageId = input.messageId.trim();
    if (!tenantId || !messageId || !this.isValidEmail(normalizedEmail)) {
      throw new BadRequestException(
        'Tenant, message ID, and a valid sender email are required',
      );
    }

    const capture = () =>
      this.prisma.$transaction(async (tx) => {
        const existingClient = await tx.client.findFirst({
          where: {
            tenantId,
            email: { equals: normalizedEmail, mode: 'insensitive' },
          },
        });

        let company: string | null = null;
        if (!existingClient) {
          const domain = this.businessDomain(normalizedEmail);
          const companyMatch = domain
            ? await tx.client.findFirst({
                where: {
                  tenantId,
                  email: { endsWith: `@${domain}`, mode: 'insensitive' },
                },
                select: { company: true },
              })
            : null;
          company =
            companyMatch?.company ||
            this.inferCompanyFromEmail(normalizedEmail) ||
            null;
        }

        const client = existingClient
          ? await tx.client.update({
              where: { id: existingClient.id },
              data:
                !existingClient.name && input.senderName?.trim()
                  ? { name: input.senderName.trim() }
                  : {},
            })
          : await tx.client.upsert({
              where: { tenantId_email: { tenantId, email: normalizedEmail } },
              create: {
                tenantId,
                email: normalizedEmail,
                name: input.senderName?.trim() || null,
                company,
                status: DEFAULT_CLIENT_STATUS,
              },
              update: input.senderName?.trim()
                ? { name: input.senderName.trim() }
                : {},
            });

        const updateData: Prisma.InteractionUpdateInput = {};
        if (input.aiSummary?.trim()) updateData.aiSummary = input.aiSummary;
        if (input.classification?.trim()) {
          updateData.classification = input.classification;
        }
        if (input.productConfidence != null) {
          updateData.productConfidence = input.productConfidence;
        }
        if (input.clientHistoryConfidence != null) {
          updateData.clientHistoryConfidence = input.clientHistoryConfidence;
        }

        const interaction = await tx.interaction.upsert({
          where: { tenant_message: { tenantId, messageId } },
          create: {
            tenantId,
            clientId: client.id,
            messageId,
            date: this.safeDate(input.date),
            type: 'inbound',
            subject: input.subject?.trim() || '(no subject)',
            aiSummary: input.aiSummary?.trim() || '',
            classification: input.classification?.trim() || null,
            productConfidence: input.productConfidence ?? null,
            clientHistoryConfidence: input.clientHistoryConfidence ?? null,
          },
          update: updateData,
        });

        return { client, interaction };
      });

    try {
      return await capture();
    } catch (error) {
      // Prisma may implement an upsert with an empty update as read-then-create.
      // If both ingestion paths race, retry the aborted transaction once and
      // let the unique keys resolve to the row created by the winner.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return capture();
      }
      throw error;
    }
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
    excludeMessageId?: string,
  ): Promise<ClientContext> {
    email = this.normalizeEmail(email);
    if (!this.isValidEmail(email)) {
      throw new BadRequestException('Client email is invalid or not provided');
    }

    try {
      const resolved = await this.resolveClientIdentity(tenantId, email);

      if (!resolved.existingClientId) {
        return {
          isNewClient: true,
          matchedBy: null,
          clientId: null,
          status: 'unknown',
          name: '',
          company: '',
          crmId: null,
          historyCount: 0,
          history: [],
        };
      }

      const client = await this.prisma.client.findFirst({
        where: { id: resolved.existingClientId, tenantId },
        include: {
          interactions: {
            ...(excludeMessageId
              ? {
                  where: {
                    OR: [
                      { messageId: null },
                      { messageId: { not: excludeMessageId } },
                    ],
                  },
                }
              : {}),
            orderBy: { date: 'desc' },
            take: 5,
          },
          // The truncated array above is for display. The Supervisor needs the
          // real total, otherwise every client with 5+ interactions grades the
          // same as one with exactly 5.
          _count: {
            select: {
              interactions: excludeMessageId
                ? {
                    where: {
                      OR: [
                        { messageId: null },
                        { messageId: { not: excludeMessageId } },
                      ],
                    },
                  }
                : true,
            },
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
          historyCount: 0,
          history: [],
        };
      }

      // A 'domain' match means we found a DIFFERENT person at the same
      // company — not this specific client. Their interaction history
      // does not belong to the person we're actually emailing, so treat
      // this as effectively a new (unverified) relationship for
      // confidence purposes, while still surfacing the company-level
      // name/company for display.
      const isDomainContext = resolved.matchedBy === 'domain';
      const isEffectivelyNew =
        isDomainContext || (client._count.interactions === 0 && !client.crmId);

      return {
        isNewClient: isEffectivelyNew,
        matchedBy: resolved.matchedBy,
        clientId: isDomainContext ? null : client.id,
        status: isDomainContext ? 'unknown' : client.status,
        name: isDomainContext ? '' : client.name || '',
        company: client.company || '',
        crmId: isDomainContext ? null : client.crmId,
        // A 'domain' match's interactions belong to a different person, so the
        // count has to be zeroed alongside the array it summarises.
        historyCount: isDomainContext ? 0 : client._count.interactions,
        history: isDomainContext
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
        historyCount: 0,
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

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  private safeDate(value?: string | Date | null): Date {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

    const raw = typeof value === 'string' ? value.trim() : '';
    const parsed = /^\d+$/.test(raw)
      ? new Date(Number(raw))
      : raw
        ? new Date(raw)
        : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private businessDomain(email: string): string | null {
    const parts = email.split('@');
    const domain = parts.length === 2 ? parts[1].toLowerCase() : null;
    const freeEmails = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    return domain && !freeEmails.includes(domain) ? domain : null;
  }
}
