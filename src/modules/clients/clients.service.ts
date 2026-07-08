import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ClientRecord } from './clients.interface';
import { CreateInteractionDto } from './clients.dto';
import { Prisma } from '@prisma/client';
import { PaginationOptions } from '@/database/pagination/pagination.types';

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateClient(
    email: string,
    name?: string,
    company?: string,
  ): Promise<ClientRecord> {
    const inferredCompany = company || this.inferCompanyFromEmail(email);

    return this.prisma.client.upsert({
      where: { email },
      update: {},
      create: {
        email,
        name: name || null,
        company: inferredCompany || null,
        status: 'new_inquiry',
      },
    });
  }

  async addInteraction(clientId: string, data: CreateInteractionDto) {
    try {
      return await this.prisma.interaction.create({
        data: {
          clientId,
          date: data.date ? new Date(data.date) : new Date(),
          type: data.type,
          subject: data.subject,
          aiSummary: data.aiSummary,
          classification: data.classification || null,
          confidence: data.confidence !== undefined ? data.confidence : null,
          recommendation: data.recommendation || null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003' // Foreign key constraint failed.
      ) {
        throw new NotFoundException(`Client with ID ${clientId} not found`);
      }
      throw error;
    }
  }

  async getClient(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
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

  async getClients(searchQuery?: string, options?: PaginationOptions) {
    const whereClause = searchQuery
      ? {
          OR: [
            { name: { contains: searchQuery, mode: 'insensitive' as const } },
            { email: { contains: searchQuery, mode: 'insensitive' as const } },
            {
              company: { contains: searchQuery, mode: 'insensitive' as const },
            },
          ],
        }
      : {};

    return this.prisma.extended.client.paginate(
      {
        where: whereClause,
        orderBy: { createdAt: 'desc' },
      },
      options,
    );
  }

  async getInteractions(clientId: string, options?: PaginationOptions) {
    const clientExists = await this.prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!clientExists) {
      throw new NotFoundException(`Client with ID ${clientId} not found`);
    }

    return this.prisma.extended.interaction.paginate(
      {
        where: { clientId },
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
