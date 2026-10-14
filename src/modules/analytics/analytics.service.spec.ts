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
  /** First-call, first-arg of a mock, narrowed to the shape the test expects. */
  const callArg = <T>(mock: jest.Mock): T =>
    (mock.mock.calls as unknown as T[][])[0][0];

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
              findUnique: jest.fn(),
            },
            knowledgeGap: {
              upsert: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            knowledgeGapReport: {
              createMany: jest.fn(),
              findUnique: jest.fn(),
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
            $transaction: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(AnalyticsService);
    prisma = module.get(PrismaService);
    (prisma.$transaction as jest.Mock).mockImplementation(
      (callback: (tx: PrismaService) => unknown) => callback(prisma),
    );
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

      expect(prisma.knowledgeGap.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            resolved: false,
            occurrences: { gte: 3 },
          },
          orderBy: [
            { resolved: 'asc' },
            { occurrences: 'desc' },
            { updatedAt: 'desc' },
            { id: 'asc' },
          ],
        }),
      );
      // evidenceTotal mirrors occurrences: the count resets on resolve and
      // rises once per newly-linked interaction, so it is the honest "of N" for
      // an evidence list that is capped at 5.
      expect(result).toEqual([
        {
          ...mockGaps[0],
          evidenceTotal: mockGaps[0].occurrences,
          evidence: [],
        },
      ]);
    });

    it('scopes alerts to the tenant when one is given', async () => {
      (prisma.knowledgeGap.findMany as jest.Mock).mockResolvedValue([]);

      await service.getKnowledgeGapAlerts(3, 'tenant-a');

      expect(prisma.knowledgeGap.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            resolved: false,
            occurrences: { gte: 3 },
            tenantId: 'tenant-a',
          },
          orderBy: [
            { resolved: 'asc' },
            { occurrences: 'desc' },
            { updatedAt: 'desc' },
            { id: 'asc' },
          ],
        }),
      );
    });

    it('does not apply the occurrence threshold to resolved gaps', async () => {
      // Resolving resets occurrences to 0. If the threshold applied to them
      // too, every resolved row would be filtered straight back out and the
      // progress bar this flag exists to feed would still read "0 of N".
      (prisma.knowledgeGap.findMany as jest.Mock).mockResolvedValue([]);

      await service.getKnowledgeGapAlerts(1, 'tenant-a', true);

      const arg = callArg<{ where: { OR?: unknown[] } }>(
        prisma.knowledgeGap.findMany as jest.Mock,
      );
      expect(arg.where.OR).toEqual([
        { resolved: false, occurrences: { gte: 1 } },
        { resolved: true },
      ]);
    });

    it('keeps filtering resolved rows out when not asked for them', async () => {
      (prisma.knowledgeGap.findMany as jest.Mock).mockResolvedValue([]);

      await service.getKnowledgeGapAlerts(1, 'tenant-a');

      const arg = callArg<{ where: Record<string, unknown> }>(
        prisma.knowledgeGap.findMany as jest.Mock,
      );
      expect(arg.where.resolved).toBe(false);
      expect(arg.where.OR).toBeUndefined();
    });
  });

  describe('knowledge gap list — episode scoping', () => {
    it('hides evidence collected before the gap was last resolved', async () => {
      // A gap resolved last month restarts at zero occurrences. Showing the old
      // examples beside that zero read as data loss.
      const resolvedAt = new Date('2026-08-01T00:00:00Z');
      const older = {
        createdAt: new Date('2026-07-20T00:00:00Z'),
        interaction: {
          subject: 'old',
          aiSummary: 'old',
          classification: null,
          date: new Date('2026-07-20T00:00:00Z'),
          client: { name: null, email: 'a@x.test', company: null },
        },
      };
      const newer = {
        createdAt: new Date('2026-08-15T00:00:00Z'),
        interaction: {
          subject: 'new',
          aiSummary: 'new',
          classification: null,
          date: new Date('2026-08-15T00:00:00Z'),
          client: { name: null, email: 'b@x.test', company: null },
        },
      };
      (prisma.knowledgeGap.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'g1',
          topic: 'pricing',
          occurrences: 1,
          resolved: false,
          resolvedAt,
          tenantId: 'tenant-a',
          createdAt: new Date(),
          updatedAt: new Date(),
          reports: [newer, older],
        },
      ]);

      const [gap] = await service.getKnowledgeGapAlerts(1, 'tenant-a');

      expect(gap.evidence).toHaveLength(1);
      expect(gap.evidence[0].subject).toBe('new');
      expect(gap.evidenceTotal).toBe(1);
    });

    it('keeps every example for a gap that has never been resolved', async () => {
      const report = {
        createdAt: new Date('2026-07-20T00:00:00Z'),
        interaction: {
          subject: 'old',
          aiSummary: 'old',
          classification: null,
          date: new Date('2026-07-20T00:00:00Z'),
          client: { name: null, email: 'a@x.test', company: null },
        },
      };
      (prisma.knowledgeGap.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'g1',
          topic: 'pricing',
          occurrences: 1,
          resolved: false,
          resolvedAt: null,
          tenantId: 'tenant-a',
          createdAt: new Date(),
          updatedAt: new Date(),
          reports: [report],
        },
      ]);

      const [gap] = await service.getKnowledgeGapAlerts(1, 'tenant-a');
      expect(gap.evidence).toHaveLength(1);
    });
  });

  describe('reportKnowledgeGap', () => {
    const interaction = {
      id: 'interaction-1',
      subject: 'Pricing for 10 seats',
      aiSummary: 'The prospect asks for pricing and a demo.',
      classification: 'demo request',
    };

    it('derives a stable topic and increments only for new email evidence', async () => {
      (prisma.interaction.findUnique as jest.Mock).mockResolvedValue(
        interaction,
      );
      (prisma.knowledgeGapReport.findUnique as jest.Mock).mockResolvedValue(
        null,
      );
      (prisma.knowledgeGap.upsert as jest.Mock).mockResolvedValue({
        id: 'gap-1',
        topic: 'pricing',
        occurrences: 0,
        resolved: false,
      });
      (prisma.knowledgeGapReport.createMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.knowledgeGap.update as jest.Mock).mockResolvedValue({
        id: 'gap-1',
        topic: 'pricing',
        occurrences: 1,
        resolved: false,
      });

      const result = await service.reportKnowledgeGap(
        ' gmail-message-1 ',
        'tenant-a',
      );

      expect(prisma.interaction.findUnique).toHaveBeenCalledWith({
        where: {
          tenant_message: {
            tenantId: 'tenant-a',
            messageId: 'gmail-message-1',
          },
        },
        select: {
          id: true,
          subject: true,
          aiSummary: true,
          classification: true,
        },
      });
      expect(prisma.knowledgeGap.upsert).toHaveBeenCalledWith({
        where: {
          tenantId_topic: { tenantId: 'tenant-a', topic: 'pricing' },
        },
        update: {},
        create: {
          topic: 'pricing',
          tenantId: 'tenant-a',
          occurrences: 0,
          resolved: false,
        },
      });
      expect(prisma.knowledgeGapReport.createMany).toHaveBeenCalledWith({
        data: {
          knowledgeGapId: 'gap-1',
          interactionId: 'interaction-1',
        },
        skipDuplicates: true,
      });
      expect(result).toEqual(
        expect.objectContaining({ occurrences: 1, reportAdded: true }),
      );
    });

    it('does not increment when the same email reports the same gap again', async () => {
      const existingGap = {
        id: 'gap-1',
        topic: 'pricing',
        occurrences: 1,
        resolved: true,
      };
      (prisma.interaction.findUnique as jest.Mock).mockResolvedValue(
        interaction,
      );
      (prisma.knowledgeGapReport.findUnique as jest.Mock).mockResolvedValue({
        knowledgeGap: existingGap,
      });

      const result = await service.reportKnowledgeGap(
        'gmail-message-1',
        'tenant-a',
      );

      expect(prisma.knowledgeGap.update).not.toHaveBeenCalled();
      expect(prisma.knowledgeGap.upsert).not.toHaveBeenCalled();
      expect(prisma.knowledgeGapReport.createMany).not.toHaveBeenCalled();
      expect(result).toEqual({ ...existingGap, reportAdded: false });
    });

    it('reopens a resolved gap only when a different email adds new evidence', async () => {
      (prisma.interaction.findUnique as jest.Mock).mockResolvedValue({
        ...interaction,
        id: 'interaction-2',
      });
      (prisma.knowledgeGapReport.findUnique as jest.Mock).mockResolvedValue(
        null,
      );
      (prisma.knowledgeGap.upsert as jest.Mock).mockResolvedValue({
        id: 'gap-1',
        topic: 'pricing',
        occurrences: 1,
        resolved: true,
      });
      (prisma.knowledgeGapReport.createMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.knowledgeGap.update as jest.Mock).mockResolvedValue({
        id: 'gap-1',
        topic: 'pricing',
        occurrences: 2,
        resolved: false,
      });

      const result = await service.reportKnowledgeGap(
        'gmail-message-2',
        'tenant-a',
      );

      expect(prisma.knowledgeGap.update).toHaveBeenCalledWith({
        where: { id: 'gap-1' },
        data: { occurrences: { increment: 1 }, resolved: false },
      });
      expect(result).toEqual(
        expect.objectContaining({ occurrences: 2, resolved: false }),
      );
    });

    it('concurrent retries converge on the first report without a second increment', async () => {
      const existingGap = {
        id: 'gap-1',
        topic: 'pricing',
        occurrences: 1,
        resolved: false,
      };
      (prisma.interaction.findUnique as jest.Mock).mockResolvedValue(
        interaction,
      );
      (prisma.knowledgeGapReport.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ knowledgeGap: existingGap });
      (prisma.knowledgeGap.upsert as jest.Mock).mockResolvedValue({
        ...existingGap,
        occurrences: 0,
      });
      (prisma.knowledgeGapReport.createMany as jest.Mock).mockResolvedValue({
        count: 0,
      });

      const result = await service.reportKnowledgeGap(
        'gmail-message-1',
        'tenant-a',
      );

      expect(prisma.knowledgeGap.update).not.toHaveBeenCalled();
      expect(result).toEqual({ ...existingGap, reportAdded: false });
    });

    it('retries one fresh transaction when first-topic creation races on P2002', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '6.19.3' },
      );
      const originalTransaction = (
        prisma.$transaction as jest.Mock
      ).getMockImplementation()!;
      (prisma.$transaction as jest.Mock)
        .mockRejectedValueOnce(p2002)
        .mockImplementationOnce(originalTransaction);
      (prisma.interaction.findUnique as jest.Mock).mockResolvedValue(
        interaction,
      );
      (prisma.knowledgeGapReport.findUnique as jest.Mock).mockResolvedValue(
        null,
      );
      (prisma.knowledgeGap.upsert as jest.Mock).mockResolvedValue({
        id: 'gap-1',
        topic: 'pricing',
        occurrences: 0,
        resolved: false,
      });
      (prisma.knowledgeGapReport.createMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.knowledgeGap.update as jest.Mock).mockResolvedValue({
        id: 'gap-1',
        topic: 'pricing',
        occurrences: 1,
        resolved: false,
      });

      const result = await service.reportKnowledgeGap(
        'gmail-message-1',
        'tenant-a',
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(result).toEqual(
        expect.objectContaining({ occurrences: 1, reportAdded: true }),
      );
    });

    it('rejects a message outside the tenant instead of accepting client topic text', async () => {
      (prisma.interaction.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.reportKnowledgeGap('gmail-message-1', 'tenant-a'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('resolveGap', () => {
    it('updates resolved to true for an existing gap without tenantId', async () => {
      const mockUpdated = { id: '1', resolved: true };
      (prisma.knowledgeGap.update as jest.Mock).mockResolvedValue(mockUpdated);

      const result = await service.resolveGap('1');
      const arg = callArg<{
        where: { id: string };
        data: { resolved: boolean; occurrences: number; resolvedAt: Date };
      }>(prisma.knowledgeGap.update as jest.Mock);
      expect(arg.where).toEqual({ id: '1' });
      expect(arg.data.resolved).toBe(true);
      // The count restarts with the topic, so a re-opened gap reports what has
      // happened since it was documented, not a lifetime total.
      expect(arg.data.occurrences).toBe(0);
      expect(arg.data.resolvedAt).toBeInstanceOf(Date);
      expect(result).toEqual(mockUpdated);
    });

    it('verifies tenant ownership and resolves gap when tenantId matches', async () => {
      const mockGap = { id: 'gap-1', tenantId: 'tenant-a', resolved: false };
      const mockUpdated = { id: 'gap-1', tenantId: 'tenant-a', resolved: true };
      (prisma.knowledgeGap.findFirst as jest.Mock).mockResolvedValue(mockGap);
      (prisma.knowledgeGap.update as jest.Mock).mockResolvedValue(mockUpdated);

      const result = await service.resolveGap('gap-1', 'tenant-a');

      // Scoped exactly like the read path. Accepting `{ tenantId: null }` let a
      // tenant admin resolve — and read back — a legacy NULL-tenant gap that
      // their own list is not allowed to show them.
      expect(prisma.knowledgeGap.findFirst).toHaveBeenCalledWith({
        where: { id: 'gap-1', tenantId: 'tenant-a' },
      });
      const upd = callArg<{
        where: { id: string };
        data: { resolved: boolean; occurrences: number };
      }>(prisma.knowledgeGap.update as jest.Mock);
      expect(upd.where).toEqual({ id: 'gap-1' });
      expect(upd.data.resolved).toBe(true);
      expect(upd.data.occurrences).toBe(0);
      expect(result).toEqual(mockUpdated);
    });

    it('throws NotFoundException when gap belongs to a different tenant (tenant isolation)', async () => {
      (prisma.knowledgeGap.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.resolveGap('gap-belonging-to-tenant-b', 'tenant-a'),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.knowledgeGap.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if gap does not exist in DB', async () => {
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
      messageId: 'msg-1',
      date: new Date('2026-07-14T12:00:00Z'),
      type: 'email',
      subject: 'Hello',
      aiSummary: 'Summary',
      classification: 'sales',
      productConfidence: 0.9,
      recommendation: 'reply',
      client: mockClient,
    };

    beforeEach(() => {
      (prisma.allowlistEntry.findMany as jest.Mock).mockResolvedValue([
        { email: 'se1@example.com' },
      ]);
      (prisma.generalAnalysis.findMany as jest.Mock).mockResolvedValue([
        { messageId: 'msg-1' },
      ]);
    });

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
          messageId: { in: ['msg-1'] },
        },
      });

      expect(prisma.interaction.findMany).toHaveBeenCalledWith({
        where: {
          date: {
            gte: new Date(Date.UTC(2026, 6, 14, 0, 0, 0, 0)),
            lte: new Date(Date.UTC(2026, 6, 14, 23, 59, 59, 999)),
          },
          client: { tenantId: 'tenant-a' },
          messageId: { in: ['msg-1'] },
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
          faqAutoReplied: false,
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

    it('returns empty array when no SEs exist on allowlist', async () => {
      (prisma.allowlistEntry.findMany as jest.Mock).mockResolvedValue([]);

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
          messageId: { in: ['msg-1'] },
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
        where: {
          OR: [{ tenantId: 'tenant-a' }, { tenantId: null }],
        },
        select: {
          email: true,
          lastLoginAt: true,
          createdAt: true,
          status: true,
        },
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
