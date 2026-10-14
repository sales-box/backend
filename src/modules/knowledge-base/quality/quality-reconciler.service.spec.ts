import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { PrismaService } from '@/database/prisma.service';
import { QualityReconcilerService } from './quality-reconciler.service';
import { QUALITY_QUEUE, EVALUATE_QUALITY_JOB } from './quality.constants';

describe('QualityReconcilerService', () => {
  let service: QualityReconcilerService;

  const mockFindMany = jest.fn();
  const mockAdd = jest.fn();
  const mockPrisma = { document: { findMany: mockFindMany } };
  const mockQueue = { add: mockAdd };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QualityReconcilerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken(QUALITY_QUEUE), useValue: mockQueue },
      ],
    }).compile();
    service = module.get(QualityReconcilerService);
    jest.clearAllMocks();
  });

  it('queries only completed docs with a null score and existing chunks', async () => {
    mockFindMany.mockResolvedValue([]);
    await service.reconcile();
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { status: 'completed', qualityScore: null, chunkCount: { gt: 0 } },
      select: { id: true },
    });
  });

  it('re-enqueues an evaluate-quality job per stuck doc with a deterministic jobId', async () => {
    mockFindMany.mockResolvedValue([{ id: 'doc-1' }, { id: 'doc-2' }]);
    const count = await service.reconcile();

    expect(count).toBe(2);
    expect(mockAdd).toHaveBeenCalledTimes(2);
    expect(mockAdd).toHaveBeenCalledWith(
      EVALUATE_QUALITY_JOB,
      { documentId: 'doc-1' },
      expect.objectContaining({ jobId: 'reconcile-quality-doc-1' }),
    );
    expect(mockAdd).toHaveBeenCalledWith(
      EVALUATE_QUALITY_JOB,
      { documentId: 'doc-2' },
      expect.objectContaining({ jobId: 'reconcile-quality-doc-2' }),
    );
  });

  it('does nothing and returns 0 when no docs are stuck', async () => {
    mockFindMany.mockResolvedValue([]);
    const count = await service.reconcile();
    expect(count).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('runs reconcile on application bootstrap and swallows errors', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
