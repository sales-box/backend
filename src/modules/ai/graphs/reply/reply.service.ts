import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import { Injectable } from '@nestjs/common';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { buildReplyGraph } from '@/modules/ai/graphs/reply/reply-graph.factory';
import { AttachmentsService } from '@/modules/attachments/attachments.service';
import { flattenParsedAttachments } from '@/modules/ai/graphs/reply/nodes/extractor/attachment-flattener';
import { AttachmentRef } from '@/modules/attachments/attachments.service';
@Injectable()
export class ReplyService {
  private readonly graph: ReturnType<typeof buildReplyGraph>;

  constructor(
    private readonly aiModelService: AiModelService,
    private readonly attachmentsService: AttachmentsService,
  ) {
    this.graph = buildReplyGraph({ aiModelService: this.aiModelService });
  }

  async draftReply(
    emailId: string,
    tenantId: string,
    emailBody: string,
    accountEmail: string,
    emailRef: { id: string; attachments: AttachmentRef[] }, // ← NEW: Gmail attachment refs
    intent?: string,
  ): Promise<ReplyGraphStateType> {
    const parsedAttachments = await this.attachmentsService.parseAttachments(
      accountEmail,
      emailRef,
    );
    const attachmentsText = flattenParsedAttachments(parsedAttachments);

    const finalState = await this.graph.invoke({
      emailId,
      tenantId,
      emailBody,
      intent,
      attachmentsText,
      externalContentText: [],
      excludedByUser: [],
    });

    return finalState;
  }
}
