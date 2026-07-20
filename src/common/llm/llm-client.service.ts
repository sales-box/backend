import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LlmKeyRotator } from './llm-key-rotator.service';

@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly clients: OpenAI[];
  private readonly model: string;
  private readonly visionModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly keyRotator: LlmKeyRotator,
  ) {
    const baseURL = this.config.get<string>('LLM_BASE_URL');
    this.clients = this.keyRotator
      .getKeys()
      .map((apiKey) => new OpenAI({ apiKey, baseURL }));
    this.model = this.config.get<string>('LLM_MODEL')!;
    this.visionModel = this.config.get<string>('VISION_MODEL')!;
  }

  /**
   * Text-only structured output, used by Classifier/Matcher/Composer/Supervisor.
   * Public interface unchanged from the Anthropic version — only the
   * implementation (OpenAI-style function/tool calling instead of
   * Anthropic tool_use) changed underneath.
   */
  async generateStructured<T>(params: {
    systemPrompt: string;
    userMessage: string;
    schema: object;
    temperature?: number;
  }): Promise<T> {
    const maxRetries = 2;
    const backoffMs = [1000, 3000];
    let attempt = 0;

    let currentKeyIdx = await this.keyRotator.next();
    let keysTried = 0;

    while (true) {
      try {
        const client = this.clients[currentKeyIdx];
        const response = await client.chat.completions.create({
          model: this.model,
          temperature: params.temperature ?? 0.2,
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userMessage },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'structured_output',
                description: 'Generate structured output matching the schema',
                parameters: params.schema as Record<string, unknown>,
              },
            },
          ],
          tool_choice: {
            type: 'function',
            function: { name: 'structured_output' },
          },
        });

        const toolCall = response.choices[0]?.message?.tool_calls?.find(
          (call) =>
            call.type === 'function' &&
            call.function.name === 'structured_output',
        );

        if (!toolCall || toolCall.type !== 'function') {
          throw new Error(
            'LLM response does not contain a structured_output tool call.',
          );
        }

        return JSON.parse(toolCall.function.arguments) as T;
      } catch (error) {
        const err = error as { status?: number; message?: string };
        const isRateLimit =
          err && (err.status === 429 || String(err.message).includes('429'));

        if (isRateLimit) {
          if (keysTried < this.clients.length - 1) {
            keysTried++;
            const oldIdx = currentKeyIdx;
            currentKeyIdx = await this.keyRotator.next();
            this.logger.warn(
              `Rate limit (429) hit on key index ${oldIdx}. Rotating to key index ${currentKeyIdx} immediately...`,
            );
            continue;
          }

          if (attempt < maxRetries) {
            const delay = backoffMs[attempt];
            attempt++;
            keysTried = 0;
            this.logger.warn(
              `Rate limit (429) hit on all keys. Retrying same-key/rotator cycle attempt ${attempt}/${maxRetries} after ${delay}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            currentKeyIdx = await this.keyRotator.next();
            continue;
          }
        }

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

  /**
   * Image/attachment understanding, used by the Extractor's vision fallback
   * and the Attachments module. Uses VISION_MODEL (currently gemini-3.1-flash-lite
   * via the Gemini OpenAI-compatible endpoint) via the same OpenAI-compatible client
   * — only the model and message shape differ from generateStructured().
   */
  async analyzeImage(
    imageBase64: string,
    prompt: string,
    mimeType: string = 'image/jpeg',
  ): Promise<string> {
    let currentKeyIdx = await this.keyRotator.next();
    let keysTried = 0;

    while (true) {
      try {
        const client = this.clients[currentKeyIdx];
        const response = await client.chat.completions.create({
          model: this.visionModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${imageBase64}`,
                  },
                },
              ],
            },
          ],
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw new Error('LLM vision response did not contain any content.');
        }

        return content;
      } catch (error: any) {
        const err = error as { status?: number; message?: string };
        const isRateLimit =
          err && (err.status === 429 || String(err.message).includes('429'));

        if (isRateLimit && keysTried < this.clients.length - 1) {
          keysTried++;
          const oldIdx = currentKeyIdx;
          currentKeyIdx = await this.keyRotator.next();
          this.logger.warn(
            `Rate limit (429) hit on vision key index ${oldIdx}. Rotating to key index ${currentKeyIdx} immediately...`,
          );
          continue;
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        this.logger.error(`Image analysis failed: ${errorMessage}`, errorStack);
        throw new Error(`LLM Vision Error: ${errorMessage}`);
      }
    }
  }
}
