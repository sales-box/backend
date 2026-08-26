import { ForbiddenException } from '@nestjs/common';

/**
 * Checkpoint key for a reply graph.
 *
 * The tenant prefix is load-bearing. `POST /ai/resume` accepts this key
 * verbatim from the request body, so without a tenant component any
 * authenticated caller who knows another tenant's Gmail thread and message id
 * could resume that tenant's paused graph and write into its agent memory.
 *
 * Mirrors `crm-actions.agent.ts`, which already scopes its `thread_id` this way.
 */
export function buildGraphThreadId(
  tenantId: string,
  threadId: string,
  messageId: string,
): string {
  return `${tenantId}:${threadId}:${messageId}`;
}

/** Throws unless `graphThreadId` was minted for `tenantId`. */
export function assertOwnsGraphThread(
  tenantId: string,
  graphThreadId: string,
): void {
  // Compare the whole first segment rather than using startsWith: a prefix
  // test would let tenant 'a' claim a key belonging to tenant 'abc'.
  if (graphThreadId.split(':')[0] !== tenantId) {
    throw new ForbiddenException('That draft does not belong to this account');
  }
}
