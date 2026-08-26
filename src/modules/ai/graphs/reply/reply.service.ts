import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import { Inject, Injectable } from '@nestjs/common';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { buildReplyGraph } from '@/modules/ai/graphs/reply/reply-graph.factory';
import { PrismaService } from '@/database/prisma.service';
import { AttachmentsService } from '@/modules/attachments/attachments.service';
import { flattenParsedAttachments } from '@/modules/ai/graphs/reply/nodes/extractor/attachment-flattener';
import { AttachmentRef } from '@/modules/attachments/attachments.service';
import {
  assertOwnsGraphThread,
  buildGraphThreadId,
} from '@/modules/ai/graphs/reply/graph-thread-id';
import { Command, BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import {
  CHECKPOINTER_TOKEN,
  STORE_TOKEN,
} from '../checkpointer/checkpointer.constants';

export interface DraftResult {
  graphThreadId: string;
  state: ReplyGraphStateType;
}

@Injectable()
export class ReplyService {
  private readonly graph: ReturnType<
    ReturnType<typeof buildReplyGraph>['compile']
  >;

  constructor(
    private readonly aiModelService: AiModelService,
    private readonly prisma: PrismaService,
    private readonly attachmentsService: AttachmentsService,
    @Inject(CHECKPOINTER_TOKEN)
    private readonly checkpointer: BaseCheckpointSaver,
    @Inject(STORE_TOKEN)
    private readonly store: BaseStore,
  ) {
    this.graph = buildReplyGraph({
      aiModelService: this.aiModelService,
      prisma: this.prisma,
    }).compile({ checkpointer: this.checkpointer, store: this.store });
  }

  async draftReply(
    messageId: string,
    threadId: string,
    tenantId: string,
    connectedAccountId: string,
    emailBody: string,
    accountEmail: string,
    emailRef: { id: string; attachments: AttachmentRef[] },
    intent?: string,
    options?: {
      /** Explicit itemized needs — overrides the extractor's derivation. */
      requirements?: string[];
      /** Products the user rejected on a previous attempt — the matcher
       *  is forbidden from recommending them again on retry. */
      excludedByUser?: string[];
      clientHistory?: ReplyGraphStateType['clientHistory'];
    },
  ): Promise<DraftResult> {
    const parsedAttachments = await this.attachmentsService.parseAttachments(
      tenantId,
      accountEmail,
      emailRef,
    );
    const attachmentsText = flattenParsedAttachments(parsedAttachments);

    const graphThreadId = buildGraphThreadId(tenantId, threadId, messageId);
    const config = {
      configurable: {
        thread_id: graphThreadId,
      },
    };

    const state = (await this.graph.invoke(
      {
        tenantId,
        connectedAccountId,
        threadId,
        messageId,
        emailBody,
        intent,
        requirements: options?.requirements,
        excludedByUser: options?.excludedByUser ?? [],
        clientHistory: options?.clientHistory ?? [],
        attachmentsText,
        externalContentText: [],
      },
      config,
    )) as ReplyGraphStateType;

    return {
      graphThreadId,
      state,
    };
  }

  async resumeWithFeedback(
    tenantId: string,
    graphThreadId: string,
    editedContent: string,
  ): Promise<ReplyGraphStateType> {
    // The key arrives from the request body; prove it belongs to this tenant
    // before handing it to the checkpointer.
    assertOwnsGraphThread(tenantId, graphThreadId);
    const config = {
      configurable: {
        thread_id: graphThreadId,
      },
    };

    const finalState = (await this.graph.invoke(
      new Command({ resume: { content: editedContent } }),
      config,
    )) as ReplyGraphStateType;

    return finalState;
  }
}
