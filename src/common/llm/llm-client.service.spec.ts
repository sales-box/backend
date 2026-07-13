import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LlmClientService } from './llm-client.service';

const mockCreateMessage = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => {
    return {
      messages: {
        create: mockCreateMessage,
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
              if (key === 'ANTHROPIC_API_KEY') {
                return 'test-api-key';
              }
              return null;
            }),
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
    it('successfully calls Anthropic API and returns structured output matching schema', async () => {
      const mockResult = {
        id: 'msg-123',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Here is the structured data.',
          },
          {
            type: 'tool_use',
            id: 'toolu-123',
            name: 'structured_output',
            input: {
              result: 'success',
              confidence: 0.95,
            },
          },
        ],
      };

      mockCreateMessage.mockResolvedValue(mockResult);

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

      expect(mockCreateMessage).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        temperature: 0.1,
        system: 'You are a test agent.',
        messages: [
          {
            role: 'user',
            content: 'Please analyze this.',
          },
        ],
        tools: [
          {
            name: 'structured_output',
            description: 'Generate structured output matching the schema',
            input_schema: schema,
          },
        ],
        tool_choice: {
          type: 'tool',
          name: 'structured_output',
        },
      });
    });

    it('defaults temperature to 0.2 if not specified', async () => {
      const mockResult = {
        content: [
          {
            type: 'tool_use',
            input: { ok: true },
          },
        ],
      };
      mockCreateMessage.mockResolvedValue(mockResult);

      await service.generateStructured({
        systemPrompt: 'test',
        userMessage: 'test',
        schema: {},
      });

      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.2,
        }),
      );
    });

    it('throws custom error if API returns an error', async () => {
      mockCreateMessage.mockRejectedValue(new Error('Invalid API Key'));

      await expect(
        service.generateStructured({
          systemPrompt: 'test',
          userMessage: 'test',
          schema: {},
        }),
      ).rejects.toThrow('LLM Generation Error: Invalid API Key');
    });

    it('throws error if tool_use block is not found in the response', async () => {
      const mockResult = {
        content: [
          {
            type: 'text',
            text: 'I refuse to return structured data.',
          },
        ],
      };
      mockCreateMessage.mockResolvedValue(mockResult);

      await expect(
        service.generateStructured({
          systemPrompt: 'test',
          userMessage: 'test',
          schema: {},
        }),
      ).rejects.toThrow(
        'LLM Generation Error: Anthropic response does not contain a structured tool_use block.',
      );
    });
  });
});
