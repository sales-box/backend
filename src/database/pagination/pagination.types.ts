export interface PaginationOptions {
  page?: number | string;
  limit?: number | string;
}

export interface PaginationResult<T> {
  data: T[];
  meta: {
    total: number;
    lastPage: number;
    currentPage: number;
    limit: number;
    prev: number | null;
    next: number | null;
  };
}
