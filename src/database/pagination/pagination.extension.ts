import { Prisma } from '@prisma/client';
import { PaginationOptions, PaginationResult } from './pagination.types';

export const paginationExtension = Prisma.defineExtension({
  name: 'pagination',
  model: {
    $allModels: {
      async paginate<T, A>(
        this: T,
        args?: Prisma.Exact<A, Prisma.Args<T, 'findMany'>>,
        options?: PaginationOptions,
      ): Promise<PaginationResult<Prisma.Result<T, A, 'findMany'>>> {
        const page = Number(options?.page ?? 1);
        const limit = Number(options?.limit ?? 10);
        const skip = page > 0 ? limit * (page - 1) : 0;

        const ctx = Prisma.getExtensionContext(this) as any;
        const queryArgs = (args || {}) as any;

        const [total, data] = await Promise.all([
          ctx.count({ where: queryArgs.where }),
          ctx.findMany({
            ...queryArgs,
            skip,
            take: limit,
          }),
        ]);

        const lastPage = Math.ceil(total / limit);

        return {
          data,
          meta: {
            total,
            lastPage,
            currentPage: page,
            limit,
            prev: page > 1 ? page - 1 : null,
            next: page < lastPage ? page + 1 : null,
          },
        };
      },
    },
  },
});
