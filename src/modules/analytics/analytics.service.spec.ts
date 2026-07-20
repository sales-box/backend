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
              findMany: jest.fn(),
            },
            knowledgeGap: {
              upsert: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            allowlistEntry: {
              findMany: jest.fn(),
            },
            connectedAccount: {
              findMany: jest.fn(),
            },
            generalAnalysis: {
              count: jest.fn(),
              groupBy: jest.fn(),
              findMany: jest.fn(),
              aggregate: jest.fn(),
            },
            $queryRaw: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(AnalyticsService);
    prisma = module.get(PrismaService);
  });

  describe('getAnalyticsSummary', () => {
    // count() is called in this order inside Promise.all:
    //   total, prevTotal, aiReviewedCount, escalatedCount
    const mockCounts = (
      total: number,
      prev: number,
      aiReviewed: number,
      escalated: number,
    ) =>
      (prisma.generalAnalysis.count as jest.Mock)
        .mockResolvedValueOnce(total)
        .mockResolvedValueOnce(prev)
        .mockResolvedValueOnce(aiReviewed)
        .mockResolvedValueOnce(escalated);

    it('computes every field from general_analysis', async () => {
      mockCounts(20, 10, 6, 2);
      (prisma.generalAnalysis.groupBy as jest.Mock).mockResolvedValue([
        { intent: 'product inquiry', _count: { intent: 12 } },
        { intent: 'support', _count: { intent: 8 } },
      ]);
      // distinct-by-thread already applied by Prisma; null thread excluded
      (prisma.generalAnalysis.findMany as jest.Mock).mockResolvedValue([
        { threadId: 't1' },
        { threadId: 't2' },
        { threadId: null },
      ]);
      (prisma.generalAnalysis.aggregate as jest.Mock).mockResolvedValue({
        _avg: { productConfidence: 0.8, clientHistoryConfidence: 0.7 },
      });
      const yday = new Date(Date.now() - 86_400_000);
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { day: yday, emails: 5 },
      ]);

      const r = await service.getAnalyticsSummary(30, 'tenant-a');

      expect(r.totalEmailsProcessed).toBe(20);
      expect(r.byClassification).toEqual({
        'product inquiry': 12,
        support: 8,
      });
      expect(r.averageConfidence).toBeCloseTo(0.75);
      expect(r.replies).toEqual({ threads: 2 }); // null thread not counted
      expect(r.aiReviewed).toEqual({ count: 6, escalated: 2 });
      expect(r.lowConfidenceCount).toBe(2); // back-compat mirror of escalated
      expect(r.momChangePct).toBe(100); // (20-10)/10
      expect(r.dailyCounts).toHaveLength(31); // days + 1
      const ydayKey = yday.toISOString().slice(5, 10);
      expect(r.dailyCounts.find((d) => d.date === ydayKey)?.emails).toBe(5);
    });

    it('escalated counts only the supervisorLabel red band', async () => {
      mockCounts(3, 0, 3, 1);
      (prisma.generalAnalysis.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.aggregate as jest.Mock).mockResolvedValue({
        _avg: { productConfidence: null, clientHistoryConfidence: null },
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.getAnalyticsSummary(30, 'tenant-a');

      const countCalls = (prisma.generalAnalysis.count as jest.Mock).mock
        .calls as [{ where?: { supervisorLabel?: string } }][];
      const redCall = countCalls.find(
        (c) => c[0]?.where?.supervisorLabel === 'red',
      );
      expect(redCall).toBeDefined();
    });

    it('momChangePct is null when the previous window is empty', async () => {
      mockCounts(5, 0, 0, 0);
      (prisma.generalAnalysis.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.aggregate as jest.Mock).mockResolvedValue({
        _avg: { productConfidence: null, clientHistoryConfidence: null },
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const r = await service.getAnalyticsSummary(30, 'tenant-a');
      expect(r.momChangePct).toBeNull(); // never +Infinity or a fake number
    });

    it('a fresh tenant yields zeros and a zero-filled chart, no crash', async () => {
      mockCounts(0, 0, 0, 0);
      (prisma.generalAnalysis.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.aggregate as jest.Mock).mockResolvedValue({
        _avg: { productConfidence: null, clientHistoryConfidence: null },
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const r = await service.getAnalyticsSummary(7, 'tenant-a');

      expect(r.totalEmailsProcessed).toBe(0);
      expect(r.averageConfidence).toBe(0);
      expect(r.replies.threads).toBe(0);
      expect(r.dailyCounts).toHaveLength(8);
      expect(r.dailyCounts.every((d) => d.emails === 0)).toBe(true);
    });

    it('scopes every general_analysis query to the tenant', async () => {
      mockCounts(0, 0, 0, 0);
      (prisma.generalAnalysis.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.aggregate as jest.Mock).mockResolvedValue({
        _avg: { productConfidence: null, clientHistoryConfidence: null },
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.getAnalyticsSummary(7, 'tenant-a');

      for (const call of (prisma.generalAnalysis.count as jest.Mock).mock
        .calls as [{ where: { tenantId: string } }][]) {
        expect(call[0].where.tenantId).toBe('tenant-a');
      }
    });

    it('throws BadRequestException for a non-positive window', async () => {
      await expect(service.getAnalyticsSummary(-3, 'tenant-a')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.generalAnalysis.count).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      await expect(service.getAnalyticsSummary(7, '')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.generalAnalysis.count).not.toHaveBeenCalled();
    });

    it('throws InternalServerErrorException on DB error', async () => {
      (prisma.generalAnalysis.count as jest.Mock).mockRejectedValue(
        new Error('DB Error'),
      );
      (prisma.generalAnalysis.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.generalAnalysis.aggregate as jest.Mock).mockResolvedValue({
        _avg: { productConfidence: null, clientHistoryConfidence: null },
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await expect(service.getAnalyticsSummary(7, 'tenant-a')).rejects.toThrow(
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

  describe('getActivityFeed', () => {
    const mockClient = { id: 'c-1', name: 'Bob', company: 'Acme' };
    const mockInteraction = {
      id: 'int-1',
      date: new Date('2026-07-14T12:00:00Z'),
      type: 'email',
      subject: 'Hello',
      aiSummary: 'Summary',
      classification: 'sales',
      productConfidence: 0.9,
      recommendation: 'reply',
      client: mockClient,
    };

    it('returns activity feed mapped correctly with calendar date bounds (S4-V1)', async () => {
      (prisma.interaction.count as jest.Mock).mockResolvedValue(1);
      (prisma.interaction.findMany as jest.Mock).mockResolvedValue([
        mockInteraction,
      ]);

      const query = { page: 1, limit: 50, date: '2026-07-14' };
      const result = await service.getActivityFeed('tenant-a', query);

      expect(prisma.interaction.count).toHaveBeenCalledWith({
        where: {
          date: {
            gte: new Date(Date.UTC(2026, 6, 14, 0, 0, 0, 0)),
            lte: new Date(Date.UTC(2026, 6, 14, 23, 59, 59, 999)),
          },
          client: { tenantId: 'tenant-a' },
        },
      });

      expect(prisma.interaction.findMany).toHaveBeenCalledWith({
        where: {
          date: {
            gte: new Date(Date.UTC(2026, 6, 14, 0, 0, 0, 0)),
            lte: new Date(Date.UTC(2026, 6, 14, 23, 59, 59, 999)),
          },
          client: { tenantId: 'tenant-a' },
        },
        include: { client: true },
        orderBy: { date: 'desc' },
        skip: 0,
        take: 50,
      });

      expect(result.data).toEqual([
        {
          id: 'int-1',
          time: mockInteraction.date,
          client: 'Bob',
          company: 'Acme',
          classification: 'sales',
          confidence: 0.9,
          action: 'reply',
        },
      ]);
      expect(result.meta).toEqual({
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      });
    });

    it('paginates correctly using skip and take', async () => {
      (prisma.interaction.count as jest.Mock).mockResolvedValue(25);
      (prisma.interaction.findMany as jest.Mock).mockResolvedValue([]);

      const query = { page: 3, limit: 10, date: '2026-07-14' };
      const result = await service.getActivityFeed('tenant-a', query);

      expect(prisma.interaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
        }),
      );
      expect(result.meta.totalPages).toBe(3);
    });

    it('returns empty array when no interactions match target date', async () => {
      (prisma.interaction.count as jest.Mock).mockResolvedValue(0);
      (prisma.interaction.findMany as jest.Mock).mockResolvedValue([]);

      const query = { page: 1, limit: 50, date: '2026-07-14' };
      const result = await service.getActivityFeed('tenant-a', query);

      expect(result.data).toEqual([]);
      expect(result.meta).toEqual({
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      });
    });

    it('filters strictly by tenantId (tenant isolation)', async () => {
      (prisma.interaction.count as jest.Mock).mockResolvedValue(0);
      (prisma.interaction.findMany as jest.Mock).mockResolvedValue([]);

      const query = { page: 1, limit: 50, date: '2026-07-14' };
      await service.getActivityFeed('tenant-b', query);

      expect(prisma.interaction.count).toHaveBeenCalledWith({
        where: {
          date: {
            gte: new Date(Date.UTC(2026, 6, 14, 0, 0, 0, 0)),
            lte: new Date(Date.UTC(2026, 6, 14, 23, 59, 59, 999)),
          },
          client: { tenantId: 'tenant-b' },
        },
      });
    });

    it('throws BadRequestException for invalid date string', async () => {
      const query = { page: 1, limit: 50, date: 'invalid-date' };
      await expect(service.getActivityFeed('tenant-a', query)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getTeamStats', () => {
    it('should throw BadRequestException if tenantId is missing or empty', async () => {
      await expect(service.getTeamStats('')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should query allowlist, connected accounts, and general analysis correctly and return stats', async () => {
      const mockAllowlist = [
        {
          email: 'se1@example.com',
          status: 'verified',
          grantedAt: new Date('2026-07-01'),
          verifiedAt: new Date('2026-07-02'),
        },
        {
          email: 'se2@example.com',
          status: 'granted',
          grantedAt: new Date('2026-07-05'),
          verifiedAt: null,
        },
      ];
      const mockConnected = [
        { email: 'se1@example.com', lastLoginAt: new Date('2026-07-15') },
      ];
      const mockReceived = [
        { accountEmail: 'se1@example.com', _count: { _all: 5 } },
        { accountEmail: 'se2@example.com', _count: { _all: 2 } },
      ];
      const mockSent = [
        { accountEmail: 'se1@example.com', _count: { _all: 3 } },
      ];

      (prisma.allowlistEntry.findMany as jest.Mock).mockResolvedValue(
        mockAllowlist,
      );
      (prisma.connectedAccount.findMany as jest.Mock).mockResolvedValue(
        mockConnected,
      );
      (prisma.generalAnalysis.groupBy as jest.Mock)
        .mockResolvedValueOnce(mockReceived) // first call for emailsReceived
        .mockResolvedValueOnce(mockSent); // second call for repliesSent

      const result = await service.getTeamStats('tenant-a');

      expect(prisma.allowlistEntry.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
        select: {
          email: true,
          status: true,
          grantedAt: true,
          verifiedAt: true,
        },
        orderBy: { grantedAt: 'desc' },
      });

      expect(prisma.connectedAccount.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
        select: { email: true, lastLoginAt: true },
      });

      expect(prisma.generalAnalysis.groupBy).toHaveBeenCalledTimes(2);

      expect(result).toEqual([
        {
          email: 'se1@example.com',
          status: 'verified',
          grantedAt: mockAllowlist[0].grantedAt,
          verifiedAt: mockAllowlist[0].verifiedAt,
          lastLoginAt: mockConnected[0].lastLoginAt,
          emailsReceived: 5,
          repliesSent: 3,
          replyRate: 0.6,
        },
        {
          email: 'se2@example.com',
          status: 'granted',
          grantedAt: mockAllowlist[1].grantedAt,
          verifiedAt: null,
          lastLoginAt: null,
          emailsReceived: 2,
          repliesSent: 0,
          replyRate: 0,
        },
      ]);
    });

    it('should throw InternalServerErrorException if a database query fails', async () => {
      (prisma.allowlistEntry.findMany as jest.Mock).mockRejectedValue(
        new Error('DB failure'),
      );
      await expect(service.getTeamStats('tenant-a')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
