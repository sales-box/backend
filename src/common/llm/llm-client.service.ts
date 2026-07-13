import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly anthropic: Anthropic;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    this.anthropic = new Anthropic({
      apiKey,
    });
  }

  async generateStructured<T>(params: {
    systemPrompt: string;
    userMessage: string;
    schema: object;
    temperature?: number;
  }): Promise<T> {
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        temperature: params.temperature ?? 0.2,
        system: params.systemPrompt,
        messages: [
          {
            role: 'user',
            content: params.userMessage,
          },
        ],
        tools: [
          {
            name: 'structured_output',
            description: 'Generate structured output matching the schema',
            input_schema: params.schema as {
              type: 'object';
              properties?: Record<string, unknown>;
              required?: string[];
            },
          },
        ],
        tool_choice: {
          type: 'tool',
          name: 'structured_output',
        },
      });

      const toolUseBlock = response.content.find(
        (block) => block.type === 'tool_use',
      );

      if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
        throw new Error(
          'Anthropic response does not contain a structured tool_use block.',
        );
      }

      return toolUseBlock.input as T;
    } catch (error: any) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Structured LLM generation failed: ${errorMessage}`,
        errorStack,
      );
      throw new Error(`LLM Generation Error: ${errorMessage}`);
    }
  }
}
