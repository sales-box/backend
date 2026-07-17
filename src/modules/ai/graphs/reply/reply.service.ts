import { CompiledStateGraph } from '@langchain/langgraph';
import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { buildReplyGraph } from '@/modules/ai/graphs/reply/reply-graph.factory';
import { PrismaService } from '@/database/prisma.service';
import { Intent } from '@/modules/ai/classifier/classifier.types';

@Injectable()
export class ReplyService {
  private readonly logger = new Logger(ReplyService.name);
  private readonly graph: CompiledStateGraph<
    ReplyGraphStateType,
    Partial<ReplyGraphStateType>,
    string
  >;

  constructor(
    private readonly aiModelService: AiModelService,
    private readonly prisma: PrismaService,
  ) {
    this.graph = buildReplyGraph({
      aiModelService: this.aiModelService,
      prisma: this.prisma,
    });
  }

  async draftReply(
    emailId: string,
    tenantId: string,
    emailBody: string,
    options?: {
      /** Classifier's verdict — routes the matcher (missing = recommendation path). */
      intent?: Intent;
      /** Itemized client needs, if an extractor provided them. */
      requirements?: string[];
      /** Products the user rejected on a previous attempt — the matcher
       *  is forbidden from recommending them again on retry. */
      excludedByUser?: string[];
    },
  ): Promise<ReplyGraphStateType> {
    try {
      const finalState = await this.graph.invoke({
        emailId,
        tenantId,
        emailBody,
        intent: options?.intent,
        requirements: options?.requirements,
        excludedByUser: options?.excludedByUser ?? [],
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
