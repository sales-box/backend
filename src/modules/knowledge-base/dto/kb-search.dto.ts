import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RubricCriterionDto {
  @ApiProperty({ example: 'price' }) category!: string;

  @ApiProperty({
    example: 'Does the document state a price?',
    description: 'The question the scorer asks of every document',
  })
  asks!: string;

  @ApiProperty({
    example: 'Price: 45,000 EGP per unit (ex-VAT)',
    description: 'A line that would satisfy this criterion',
  })
  example!: string;

  @ApiProperty({
    example: 25,
    description: 'Points this criterion is worth, out of 100',
  })
  worth!: number;
}

export class QualityCriteriaResponseDto {
  @ApiProperty({
    type: [RubricCriterionDto],
    description: 'Most valuable first',
  })
  criteria!: RubricCriterionDto[];

  @ApiProperty({
    example: { good: 80, fair: 50 },
    description:
      'Score bands. At or above good is healthy; below fair is weak. Published here so the dashboard cannot disagree with the scorer.',
  })
  bands!: { good: number; fair: number };
}

export class QualityGapDto {
  @ApiProperty({ example: 'price' }) category!: string;

  @ApiProperty({ example: 'Does the document state a price?' })
  asks!: string;

  @ApiProperty({
    example: 'Price: 45,000 EGP per unit (ex-VAT)',
    description: 'A line that would close this gap',
  })
  example!: string;

  @ApiProperty({
    example: 25,
    description: 'Points adding it would gain',
  })
  worth!: number;
}

export class QualityPreviewResponseDto {
  @ApiProperty({ example: 'pricing.pdf' }) filename!: string;

  @ApiProperty({
    example: 67,
    description: 'Coverage score out of 100, computed without storing anything',
  })
  score!: number;

  @ApiProperty({
    example: 12,
    description: 'How many passages this file would be split into',
  })
  chunks!: number;

  @ApiProperty({
    description:
      'True when the text extraction itself looks unreliable — a scanned PDF, a near-empty file. Independent of the score.',
  })
  isLowConfidence!: boolean;

  @ApiPropertyOptional({
    example: 'Very little extractable text (42 characters)',
  })
  qualityReason?: string;

  @ApiProperty({
    type: [String],
    description: 'Criteria this file already satisfies',
    example: ['price', 'technical_specs'],
  })
  covers!: string[];

  @ApiProperty({
    type: [QualityGapDto],
    description: 'What is missing, most valuable first',
  })
  gaps!: QualityGapDto[];

  @ApiProperty({
    description:
      'Always false here. Repetition is measured by comparing chunk embeddings, which do not exist until the file is stored and indexed — so a preview cannot report it, and says so rather than implying a complete verdict.',
    example: false,
  })
  redundancyMeasured!: boolean;
}

export class KbSearchRequestDto {
  @ApiProperty({
    example: 'What is the lead time on the WP-120 pump?',
    description: 'A question phrased the way a client would ask it',
  })
  @IsString()
  // A single word retrieves noise and a wall of text is a paste accident.
  // The keyword half also drops tokens of length 1, so one character would
  // search for nothing at all.
  @MinLength(3)
  @MaxLength(1000)
  question!: string;
}

export class KbSearchHitDto {
  @ApiProperty() chunkId!: string;
  @ApiProperty() documentId!: string;

  @ApiProperty({
    example: 'Pricing 2026.pdf',
    description: 'Which uploaded document this passage came from',
  })
  filename!: string;

  @ApiPropertyOptional({
    description: 'Position of the passage inside its document, 0-based',
  })
  chunkIndex?: number | null;

  @ApiProperty({ description: 'The passage the AI would read' })
  content!: string;

  @ApiPropertyOptional({
    example: 0.82,
    description:
      'Cosine similarity, 0-1. Null when the passage came only from the keyword half, which has no comparable score.',
  })
  similarity?: number | null;

  @ApiProperty({
    enum: ['strong', 'moderate', 'weak'],
    description:
      'How well this passage really matches. Vector search always returns its top results, so a weak hit means "this came back, but it does not answer the question".',
  })
  strength!: 'strong' | 'moderate' | 'weak';

  @ApiProperty({
    enum: ['semantic', 'keyword', 'both'],
    description:
      'Which half of the hybrid search surfaced it. "both" is the strongest signal.',
  })
  foundBy!: 'semantic' | 'keyword' | 'both';

  @ApiProperty({
    description:
      'True when the source document had an unreliable text extraction (e.g. a scanned PDF)',
  })
  isLowConfidence!: boolean;
}

export class KbSearchResponseDto {
  @ApiProperty() question!: string;

  @ApiProperty({
    enum: ['ok', 'weak_match', 'no_match', 'empty_knowledge_base'],
    description:
      'ok = at least one passage really answers this. weak_match = passages came back but none of them answers it — the usual result for a topic the knowledge base does not cover. no_match = documents exist, retrieval found none. empty_knowledge_base = nothing indexed yet.',
  })
  outcome!: 'ok' | 'weak_match' | 'no_match' | 'empty_knowledge_base';

  @ApiProperty({ description: 'Round-trip time in milliseconds' })
  tookMs!: number;

  @ApiProperty({
    description: 'How many passages each half returned before fusion',
    example: { semantic: 20, keyword: 6 },
  })
  candidates!: { semantic: number; keyword: number };

  @ApiProperty({ type: [KbSearchHitDto], description: 'Best first' })
  hits!: KbSearchHitDto[];
}
