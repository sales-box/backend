import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class LlmKeyRotator {
  private readonly logger = new Logger(LlmKeyRotator.name);
  private readonly keys: string[];
  private localCounter = 0;
  private isRedisHealthy = true;

  constructor(
    private readonly config: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {
    const keysStr = this.config.get<string>('LLM_API_KEYS');
    if (!keysStr) {
      throw new Error('LLM_API_KEYS is not configured or empty');
    }
    this.keys = keysStr
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (this.keys.length < 1) {
      throw new Error('At least 1 API key must be provided in LLM_API_KEYS');
    }

    // Register Redis error handler to prevent process crash and track health
    this.redis.on('error', (err) => {
      if (this.isRedisHealthy) {
        this.logger.warn(
          `Redis connection error in LlmKeyRotator: ${err.message}. Falling back to in-memory counter.`,
        );
        this.isRedisHealthy = false;
      }
    });

    this.redis.on('ready', () => {
      if (!this.isRedisHealthy) {
        this.logger.log('Redis connection re-established in LlmKeyRotator.');
        this.isRedisHealthy = true;
      }
    });
  }

  getKeys(): string[] {
    return this.keys;
  }

  async next(): Promise<number> {
    if (!this.isRedisHealthy) {
      const idx = this.localCounter % this.keys.length;
      this.localCounter = (this.localCounter + 1) % 1000000;
      return idx;
    }

    try {
      const val = await this.redis.incr('llm:key-rotator:cursor');
      return val % this.keys.length;
    } catch (err: unknown) {
      if (this.isRedisHealthy) {
        this.logger.warn(
          `Redis INCR failed: ${(err as Error).message}. Falling back to in-memory counter.`,
        );
        this.isRedisHealthy = false;
      }
      const idx = this.localCounter % this.keys.length;
      this.localCounter = (this.localCounter + 1) % 1000000;
      return idx;
    }
  }
}
