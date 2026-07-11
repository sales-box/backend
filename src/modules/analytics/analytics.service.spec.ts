/* eslint-disable @typescript-eslint/unbound-method */
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../../database/prisma.service';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: PrismaService,
          useValue: {
            interaction: {
              count: jest.fn(),
              groupBy: jest.fn(),
              aggregate: jest.fn(),
            },
            knowledgeGap: {
              upsert: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get(AnalyticsService);
    prisma = module.get(PrismaService);
  });

  describe('getAnalyticsSummary', () => {
    it('returns correct byClassification counts from seeded data', async () => {
      (prisma.interaction.count as jest.Mock)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(2);
      (prisma.interaction.groupBy as jest.Mock).mockResolvedValue([
        { classification: 'product_inquiry', _count: { classification: 6 } },
        { classification: 'meeting_request', _count: { classification: 4 } },
      ]);
      (prisma.interaction.aggregate as jest.Mock).mockResolvedValue({
        _avg: { confidence: 0.78 },
      });

      const result = await service.getAnalyticsSummary(7);

      expect(result.totalEmailsProcessed).toBe(10);
      expect(result.byClassification).toEqual({
        product_inquiry: 6,
        meeting_request: 4,
      });
      expect(result.averageConfidence).toBe(0.78);
      expect(result.lowConfidenceCount).toBe(2);
    });

    it('returns all zeros with zero interactions, no crash', async () => {
      (prisma.interaction.count as jest.Mock).mockResolvedValue(0);
      (prisma.interaction.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.interaction.aggregate as jest.Mock).mockResolvedValue({
        _avg: { confidence: null },
      });

      const result = await service.getAnalyticsSummary(7);

      expect(result).toEqual({
        totalEmailsProcessed: 0,
        byClassification: {},
        averageConfidence: 0,
        lowConfidenceCount: 0,
      });
    });

    it('throws BadRequestException for negative days', async () => {
      await expect(service.getAnalyticsSummary(-3)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.interaction.count).not.toHaveBeenCalled();
    });

    it('scopes every query to the tenant through the client relation (S3-V11)', async () => {
      (prisma.interaction.count as jest.Mock).mockResolvedValue(0);
      (prisma.interaction.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.interaction.aggregate as jest.Mock).mockResolvedValue({
        _avg: { confidence: null },
      });

      await service.getAnalyticsSummary(7, 'tenant-a');

      type WhereArg = [{ where: { client?: { tenantId: string } } }];
      const countWhere = (
        (prisma.interaction.count as jest.Mock).mock.calls as WhereArg[]
      )[0][0].where;
      const groupWhere = (
        (prisma.interaction.groupBy as jest.Mock).mock.calls as WhereArg[]
      )[0][0].where;
      const aggWhere = (
        (prisma.interaction.aggregate as jest.Mock).mock.calls as WhereArg[]
      )[0][0].where;
      expect(countWhere.client).toEqual({ tenantId: 'tenant-a' });
      expect(groupWhere.client).toEqual({ tenantId: 'tenant-a' });
      expect(aggWhere.client).toEqual({ tenantId: 'tenant-a' });
    });

    it('throws InternalServerErrorException on DB error', async () => {
      (prisma.interaction.count as jest.Mock).mockRejectedValue(
        new Error('DB Error'),
      );

      await expect(service.getAnalyticsSummary(7)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('upsertKnowledgeGap', () => {
    it('rejects empty or whitespace-only topics', async () => {
      await expect(service.upsertKnowledgeGap('   ')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.knowledgeGap.upsert).not.toHaveBeenCalled();
    });

    it('upserts per (tenantId, topic) when a tenant is given — normalized topic', async () => {
      const mockResult = {
        id: '1',
        topic: 'test topic',
        occurrences: 1,
        resolved: false,
      };
      (prisma.knowledgeGap.upsert as jest.Mock).mockResolvedValue(mockResult);

      const result = await service.upsertKnowledgeGap(
        '  TEST ToPiC  ',
        'tenant-a',
      );

      expect(prisma.knowledgeGap.upsert).toHaveBeenCalledWith({
        where: {
          tenantId_topic: { tenantId: 'tenant-a', topic: 'test topic' },
        },
        update: { occurrences: { increment: 1 }, resolved: false },
        create: {
          topic: 'test topic',
          tenantId: 'tenant-a',
          occurrences: 1,
          resolved: false,
        },
      });
      expect(result).toEqual(mockResult);
    });

    it('same topic for two different tenants targets two separate rows (S3-V12)', async () => {
      (prisma.knowledgeGap.upsert as jest.Mock).mockResolvedValue({});

      await service.upsertKnowledgeGap('pricing', 'tenant-a');
      await service.upsertKnowledgeGap('pricing', 'tenant-b');

      const wheres = (prisma.knowledgeGap.upsert as jest.Mock).mock.calls.map(
        (c: [{ where: unknown }]) => c[0].where,
      );
      expect(wheres).toEqual([
        { tenantId_topic: { tenantId: 'tenant-a', topic: 'pricing' } },
        { tenantId_topic: { tenantId: 'tenant-b', topic: 'pricing' } },
      ]);
    });

    it('without a tenant, emulates the upsert against the NULL-tenant row', async () => {
      (prisma.knowledgeGap.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.knowledgeGap.create as jest.Mock).mockResolvedValue({
        id: '1',
        topic: 'test topic',
      });

      await service.upsertKnowledgeGap('  TEST ToPiC  ');

      expect(prisma.knowledgeGap.upsert).not.toHaveBeenCalled();
      expect(prisma.knowledgeGap.findFirst).toHaveBeenCalledWith({
        where: { topic: 'test topic', tenantId: null },
      });
      expect(prisma.knowledgeGap.create).toHaveBeenCalledWith({
        data: { topic: 'test topic', occurrences: 1, resolved: false },
      });
    });

    it('without a tenant, increments the existing NULL-tenant row', async () => {
      (prisma.knowledgeGap.findFirst as jest.Mock).mockResolvedValue({
        id: 'gap-1',
      });
      (prisma.knowledgeGap.update as jest.Mock).mockResolvedValue({
        id: 'gap-1',
      });

      await service.upsertKnowledgeGap('pricing');

      expect(prisma.knowledgeGap.update).toHaveBeenCalledWith({
        where: { id: 'gap-1' },
        data: { occurrences: { increment: 1 }, resolved: false },
      });
      expect(prisma.knowledgeGap.create).not.toHaveBeenCalled();
    });
  });

  describe('getKnowledgeGapAlerts', () => {
    it('returns unresolved gaps with occurrences >= threshold', async () => {
      const mockGaps = [
        { id: '1', topic: 'pricing', occurrences: 4, resolved: false },
      ];
      (prisma.knowledgeGap.findMany as jest.Mock).mockResolvedValue(mockGaps);

      const result = await service.getKnowledgeGapAlerts(3);

      expect(prisma.knowledgeGap.findMany).toHaveBeenCalledWith({
        where: {
          resolved: false,
          occurrences: { gte: 3 },
        },
        orderBy: { occurrences: 'desc' },
      });
      expect(result).toEqual(mockGaps);
    });

    it('scopes alerts to the tenant when one is given', async () => {
      (prisma.knowledgeGap.findMany as jest.Mock).mockResolvedValue([]);

      await service.getKnowledgeGapAlerts(3, 'tenant-a');

      expect(prisma.knowledgeGap.findMany).toHaveBeenCalledWith({
        where: {
          resolved: false,
          occurrences: { gte: 3 },
          tenantId: 'tenant-a',
        },
        orderBy: { occurrences: 'desc' },
      });
    });
  });

  describe('resolveGap', () => {
    it('updates resolved to true for an existing gap', async () => {
      const mockUpdated = { id: '1', resolved: true };
      (prisma.knowledgeGap.update as jest.Mock).mockResolvedValue(mockUpdated);

      const result = await service.resolveGap('1');
      expect(prisma.knowledgeGap.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { resolved: true },
      });
      expect(result).toEqual(mockUpdated);
    });

    it('throws NotFoundException if gap does not exist', async () => {
      // Simulate Prisma P2025
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Record to update not found',
        {
          code: 'P2025',
          clientVersion: '6.19.3',
        },
      );
      (prisma.knowledgeGap.update as jest.Mock).mockRejectedValue(prismaError);

      await expect(service.resolveGap('not-found')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
