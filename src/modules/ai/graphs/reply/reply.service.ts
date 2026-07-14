import { CompiledStateGraph } from '@langchain/langgraph';
import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { buildReplyGraph } from '@/modules/ai/graphs/reply/reply-graph.factory';

@Injectable()
export class ReplyService {
  private readonly logger = new Logger(ReplyService.name);
  private readonly graph: CompiledStateGraph<
    ReplyGraphStateType,
    Partial<ReplyGraphStateType>,
    string
  >;

  constructor(private readonly aiModelService: AiModelService) {
    this.graph = buildReplyGraph({ aiModelService: this.aiModelService });
  }

  async draftReply(
    emailId: string,
    tenantId: string,
    emailBody: string,
  ): Promise<ReplyGraphStateType> {
    try {
      const finalState = await this.graph.invoke({
        emailId,
        tenantId,
        emailBody,
        excludedByUser: [],
      });

      this.logger.log(`Reply pipeline finished for email ${emailId}`);
      return finalState as ReplyGraphStateType;
    } catch (error) {
      this.logger.error(
        `Error occurred while drafting reply for email ${emailId}: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw error;
    }
  }
}
