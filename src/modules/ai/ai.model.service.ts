import z from 'zod';
import { Injectable, Logger } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { ConfigService } from '@nestjs/config';

export type MessageInput = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface GenerateStructuredParams<T extends z.ZodTypeAny> {
  schema: T;
  messages: MessageInput[];
  runName?: string;
}

@Injectable()
export class AiModelService {
  private readonly logger = new Logger(AiModelService.name);
  private readonly chatModel: BaseChatModel;

  constructor(private readonly config: ConfigService) {
    this.chatModel = new ChatOpenAI({
      apiKey: this.config.getOrThrow<string>('LLM_API_KEY'),
      model: this.config.getOrThrow<string>('LLM_MODEL'),
      configuration: {
        baseURL: this.config.getOrThrow<string>('LLM_BASE_URL'),
      },
      temperature: 0,
      maxRetries: 3,
      timeout: 15000,
    });
  }

  async generateStructured<T extends z.ZodTypeAny>(
    params: GenerateStructuredParams<T>,
  ): Promise<z.infer<T>> {
    const { schema, messages, runName } = params;

    try {
      const chain = this.chatModel.withStructuredOutput(schema, {
        name: runName,
        method: 'functionCalling', // TODO: edit when using new models that support structured output natively
      });

      return (await chain.invoke(messages)) as z.infer<T>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        `Error generating structured output: ${message}`,
        stack,
      );
      throw new Error(`Error generating structured output: ${message}`);
    }
  }

  // Placeholder methods for embedding functionality, to be implemented later
  embedQuery(): Promise<number[]> {
    throw new Error('Not implemented');
  }

  embedDocuments(): Promise<number[][]> {
    throw new Error('Not implemented');
  }

  getChatModel(): BaseChatModel {
    return this.chatModel;
  }
}
