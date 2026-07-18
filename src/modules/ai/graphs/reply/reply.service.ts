import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import { Injectable } from '@nestjs/common';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { buildReplyGraph } from '@/modules/ai/graphs/reply/reply-graph.factory';
import { PrismaService } from '@/database/prisma.service';
import { AttachmentsService } from '@/modules/attachments/attachments.service';
import { flattenParsedAttachments } from '@/modules/ai/graphs/reply/nodes/extractor/attachment-flattener';
import { AttachmentRef } from '@/modules/attachments/attachments.service';
import { MemorySaver, InMemoryStore } from '@langchain/langgraph';

@Injectable()
export class ReplyService {
  private readonly graph: ReturnType<
    ReturnType<typeof buildReplyGraph>['compile']
  >;

  constructor(
    private readonly aiModelService: AiModelService,
    private readonly prisma: PrismaService,
    private readonly attachmentsService: AttachmentsService,
  ) {
    const checkpointer = new MemorySaver();
    const store = new InMemoryStore();

    this.graph = buildReplyGraph({
      aiModelService: this.aiModelService,
      prisma: this.prisma,
    }).compile({ checkpointer, store });
  }

  async draftReply(
    emailId: string,
    tenantId: string,
    emailBody: string,
    accountEmail: string,
    emailRef: { id: string; attachments: AttachmentRef[] },
    // Positional to match the orchestrator caller (AiOrchestratorService).
    // A plain string: the classifier's intent comes from a GeneralAnalysis
    // DB row. routeByIntent narrows it (unknown → recommendation path).
    intent?: string,
    options?: {
      /** Explicit itemized needs — overrides the extractor's derivation. */
      requirements?: string[];
      /** Products the user rejected on a previous attempt — the matcher
       *  is forbidden from recommending them again on retry. */
      excludedByUser?: string[];
    },
  ): Promise<ReplyGraphStateType> {
    const parsedAttachments = await this.attachmentsService.parseAttachments(
      accountEmail,
      emailRef,
    );
    const attachmentsText = flattenParsedAttachments(parsedAttachments);

    const config = {
      configurable: {
        thread_id: emailId,
      },
    };

    const finalState = await this.graph.invoke(
      {
        tenantId,
        threadId: emailId,
        messageId: emailId,
        emailBody,
        intent,
        requirements: options?.requirements,
        excludedByUser: options?.excludedByUser ?? [],
        attachmentsText,
        externalContentText: [],
      },
      config,
    );

    return finalState;
  }
}
