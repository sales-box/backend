import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LlmClientService } from './llm-client.service';
import { LlmKeyRotator } from './llm-key-rotator.service';

const mockCreateCompletion = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => {
    return {
      chat: {
        completions: {
          create: mockCreateCompletion,
        },
      },
    };
  });
});

describe('LlmClientService', () => {
  let service: LlmClientService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmClientService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              const values: Record<string, string> = {
                LLM_API_KEY: 'test-api-key',
                LLM_BASE_URL: 'https://api.groq.com/openai/v1',
                LLM_MODEL: 'llama-3.3-70b-versatile',
                VISION_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct',
              };
              return values[key] ?? null;
            }),
          },
        },
        {
          provide: LlmKeyRotator,
          useValue: {
            getKeys: jest.fn().mockReturnValue(['test-api-key']),
            next: jest.fn().mockResolvedValue(0),
          },
        },
      ],
    }).compile();

    service = module.get<LlmClientService>(LlmClientService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateStructured', () => {
    it('successfully calls the LLM API and returns structured output matching schema', async () => {
      const mockResult = {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-123',
                  type: 'function',
                  function: {
                    name: 'structured_output',
                    arguments: JSON.stringify({
                      result: 'success',
                      confidence: 0.95,
                    }),
                  },
                },
              ],
            },
          },
        ],
      };

      mockCreateCompletion.mockResolvedValue(mockResult);

      const schema = {
        type: 'object',
        properties: {
          result: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['result', 'confidence'],
      };

      const res = await service.generateStructured<{
        result: string;
        confidence: number;
      }>({
        systemPrompt: 'You are a test agent.',
        userMessage: 'Please analyze this.',
        schema,
        temperature: 0.1,
      });

      expect(res).toEqual({
        result: 'success',
        confidence: 0.95,
      });

      expect(mockCreateCompletion).toHaveBeenCalledWith({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        messages: [
          { role: 'system', content: 'You are a test agent.' },
          { role: 'user', content: 'Please analyze this.' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'structured_output',
              description: 'Generate structured output matching the schema',
              parameters: schema,
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: 'structured_output' },
        },
      });
    });

    it('defaults temperature to 0.2 if not specified', async () => {
      const mockResult = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'structured_output',
                    arguments: JSON.stringify({ ok: true }),
                  },
                },
              ],
            },
          },
        ],
      };
      mockCreateCompletion.mockResolvedValue(mockResult);

      await service.generateStructured({
        systemPrompt: 'test',
        userMessage: 'test',
        schema: {},
      });

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.2,
        }),
      );
    });

    it('throws custom error if API returns an error', async () => {
      mockCreateCompletion.mockRejectedValue(new Error('Invalid API Key'));

      await expect(
        service.generateStructured({
          systemPrompt: 'test',
          userMessage: 'test',
          schema: {},
        }),
      ).rejects.toThrow('LLM Generation Error: Invalid API Key');
    });

    it('throws error if structured_output tool call is not found in the response', async () => {
      const mockResult = {
        choices: [
          {
            message: {
              content: 'I refuse to return structured data.',
              tool_calls: undefined,
            },
          },
        ],
      };
      mockCreateCompletion.mockResolvedValue(mockResult);

      await expect(
        service.generateStructured({
          systemPrompt: 'test',
          userMessage: 'test',
          schema: {},
        }),
      ).rejects.toThrow(
        'LLM Generation Error: LLM response does not contain a structured_output tool call.',
      );
    });

    it('retries on 429 rate limit error and succeeds on subsequent attempt', async () => {
      const mockRateLimitError = new Error('Rate limit exceeded 429');
      (mockRateLimitError as Error & { status: number }).status = 429;

      const mockSuccessResult = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'structured_output',
                    arguments: JSON.stringify({ ok: true }),
                  },
                },
              ],
            },
          },
        ],
      };

      mockCreateCompletion
        .mockRejectedValueOnce(mockRateLimitError)
        .mockResolvedValueOnce(mockSuccessResult);

      const setTimeoutSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((cb: Parameters<typeof setTimeout>[0]) => {
          if (typeof cb === 'function') cb();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      const res = await service.generateStructured({
        systemPrompt: 'test',
        userMessage: 'test',
        schema: {},
      });

      expect(res).toEqual({ ok: true });
      expect(mockCreateCompletion).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      setTimeoutSpy.mockRestore();
    });

    it('retries on 429 rate limit error and fails after exceeding max retries', async () => {
      const mockRateLimitError = new Error('Rate limit exceeded 429');
      (mockRateLimitError as Error & { status: number }).status = 429;

      mockCreateCompletion.mockRejectedValue(mockRateLimitError);

      const setTimeoutSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((cb: Parameters<typeof setTimeout>[0]) => {
          if (typeof cb === 'function') cb();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      await expect(
        service.generateStructured({
          systemPrompt: 'test',
          userMessage: 'test',
          schema: {},
        }),
      ).rejects.toThrow('LLM Generation Error: Rate limit exceeded 429');

      expect(mockCreateCompletion).toHaveBeenCalledTimes(3);
      expect(setTimeoutSpy).toHaveBeenNthCalledWith(
        1,
        expect.any(Function),
        1000,
      );
      expect(setTimeoutSpy).toHaveBeenNthCalledWith(
        2,
        expect.any(Function),
        3000,
      );
      setTimeoutSpy.mockRestore();
    });
  });

  describe('analyzeImage', () => {
    it('successfully calls the vision model and returns text content', async () => {
      const mockResult = {
        choices: [
          {
            message: {
              content: 'This image shows an invoice for $500.',
            },
          },
        ],
      };
      mockCreateCompletion.mockResolvedValue(mockResult);

      const res = await service.analyzeImage(
        'base64imagedata',
        'Describe this attachment.',
      );

      expect(res).toBe('This image shows an invoice for $500.');
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        }),
      );
    });

    it('throws custom error if vision API returns an error', async () => {
      mockCreateCompletion.mockRejectedValue(new Error('Rate limited'));

      await expect(
        service.analyzeImage('base64imagedata', 'Describe this.'),
      ).rejects.toThrow('LLM Vision Error: Rate limited');
    });
  });
});
