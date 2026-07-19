import z from 'zod';
import { Injectable, Logger } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
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
  private readonly embeddings: OpenAIEmbeddings;

  constructor(private readonly config: ConfigService) {
    this.chatModel = new ChatOpenAI({
      apiKey: this.config.getOrThrow<string>('LLM_API_KEY'),
      model: this.config.getOrThrow<string>('LLM_MODEL'),
      configuration: {
        baseURL: this.config.getOrThrow<string>('LLM_BASE_URL'),
      },
      temperature: 0,
      maxRetries: 3,
      // gemini-3.1-flash-lite is a Gemini 3-series reasoning model with
      // "thinking" enabled by default. The Composer/Extractor/Matcher
      // prompts ask for genuine reasoning (claim verification, hallucination
      // checks) and were timing out at the old 15s ceiling — logged as a
      // generic "Connection error." with no status code. Raised to give the
      // model room; revisit downward once/if thinking effort is tuned down
      // via a Gemini-specific extra_body param.
      timeout: 45000,
    });

    const embeddingDimensions = this.config.get<string>('EMBEDDING_DIMENSIONS');
    this.embeddings = new OpenAIEmbeddings({
      apiKey: this.config.getOrThrow<string>('EMBEDDING_API_KEY'),
      model: this.config.getOrThrow<string>('EMBEDDING_MODEL'),
      ...(embeddingDimensions
        ? { dimensions: Number(embeddingDimensions) }
        : {}),
      configuration: {
        baseURL: this.config.getOrThrow<string>('EMBEDDING_BASE_URL'),
      },
      maxRetries: 3,
      // embedQuery() is now a mandatory call on every draftReply
      // (matcherNode.semanticSearch, PR #84) — not the trivial isolated
      // call that passed at 991ms. Real in-pipeline embedding requests
      // were hitting this 15s ceiling and failing as a generic
      // "Connection error.", matching the observed 11-15s failure window
      // in draftReply. Raised to match the ChatOpenAI timeout below.
      timeout: 45000,
    });
  }

  async generateStructured<T extends z.ZodTypeAny>(
    params: GenerateStructuredParams<T>,
  ): Promise<z.infer<T>> {
    const { schema, messages, runName } = params;

    try {
      const chain = this.chatModel.withStructuredOutput(schema, {
        name: runName,
        method: 'functionCalling',
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

  async embedQuery(text: string): Promise<number[]> {
    try {
      return await this.embeddings.embedQuery(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      this.logger.error(`Error embedding query: ${message}`, stack);
      throw new Error(`Error embedding query: ${message}`);
    }
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    try {
      return await this.embeddings.embedDocuments(texts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      this.logger.error(`Error embedding documents: ${message}`, stack);
      throw new Error(`Error embedding documents: ${message}`);
    }
  }

  getChatModel(): BaseChatModel {
    return this.chatModel;
  }
}
