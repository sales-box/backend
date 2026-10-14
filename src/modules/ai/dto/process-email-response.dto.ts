import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The routing decision block. This is the contract the Chrome extension codes
 * against to pick a screen, so it is pinned here rather than left as an
 * untyped pass-through of the Supervisor's internal output type.
 *
 * `label` is the authority. The two scores are for display — a consumer that
 * re-derives its own thresholds from them will disagree with the backend the
 * first time either threshold moves.
 */
export class ProcessEmailConfidenceDto {
  @ApiProperty({
    example: 0.94,
    minimum: 0,
    maximum: 1,
    description:
      'How well the answer is grounded: intent confidence (30%), extraction certainty (30%), KB match (40%). Display only.',
  })
  productConfidence!: number;

  @ApiProperty({
    example: 0.4,
    minimum: 0,
    maximum: 1,
    description:
      'How well we know this person: max(min(1, interactions/5), 0.4). Display only. 0.4 means "0 to 2 interactions".',
  })
  clientHistoryConfidence!: number;

  @ApiProperty({
    enum: ['auto_worthy', 'needs_review', 'handle_manually'],
    example: 'needs_review',
    description:
      'THE routing authority. Maps to the panel screens green / yellow / red and to GeneralAnalysis.supervisorLabel.',
  })
  label!: 'auto_worthy' | 'needs_review' | 'handle_manually';

  @ApiProperty({
    enum: [
      'pipeline_error',
      'hallucination',
      'sensitive_intent',
      'urgent',
      'thin_history',
      'confidence',
    ],
    example: 'thin_history',
    description:
      'Which rule produced the label, in precedence order. Lets the panel explain a held-back draft that also shows a 98% score. pipeline_error means the draft graph threw — distinct from hallucination, where a draft exists but is wrong.',
  })
  labelReason!:
    | 'pipeline_error'
    | 'hallucination'
    | 'sensitive_intent'
    | 'urgent'
    | 'thin_history'
    | 'confidence';

  @ApiProperty({
    example: false,
    description:
      'A claim in the draft contradicts the knowledge base. Absolute veto — forces handle_manually and suppresses the draft.',
  })
  hallucinationDetected!: boolean;

  @ApiProperty({
    example: 1,
    description:
      'Claims worth a human glance. Counted and shown, but never lowers the label on its own.',
  })
  flaggedClaimsCount!: number;

  @ApiProperty({
    example: true,
    description: 'False only when a hallucination suppressed the draft.',
  })
  draftAvailable!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Set when the Matcher found no strong product fit — a hint for the Admin that the KB is missing coverage.',
  })
  knowledgeGapSuggestion!: string | null;
}

/**
 * The classifier row as returned to the panel. Already on the wire today; typed
 * here so consumers stop having to guess which fields survive the round trip.
 */
export class ProcessEmailClassificationDto {
  @ApiProperty({
    example: 'product inquiry',
    description:
      'One of: product inquiry, demo request, support, follow-up, sensitive.',
  })
  intent!: string;

  @ApiProperty({ example: 0.97, minimum: 0, maximum: 1 })
  intentConfidence!: number;

  @ApiProperty({ example: true })
  isUrgent!: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Client asks for a quote before Friday.',
  })
  urgencyReason?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['green', 'yellow', 'red'],
    example: 'yellow',
    description: 'Persisted colour form of confidence.label.',
  })
  supervisorLabel!: string | null;
}

export class ProcessEmailClientDto {
  @ApiProperty({ type: String, nullable: true, example: 'Dana Whitfield' })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Northwind Energy' })
  company!: string | null;

  @ApiProperty({
    example: 'active',
    description: "CRM status, or 'unknown' when the sender isn't in the CRM.",
  })
  status!: string;

  @ApiProperty({
    example: false,
    description:
      "True for an unknown sender AND for a 'domain' match — someone else at a known company, whose history is not this person's.",
  })
  isNewClient!: boolean;
}

/**
 * POST /ai/process — the pipeline result.
 *
 * Two shapes share this endpoint. When the SE has already replied to the thread
 * the pipeline short-circuits and only `alreadyReplied` and `summary` are
 * present; every other field is absent. Check `alreadyReplied` first.
 */
export class ProcessEmailResponseDto {
  @ApiPropertyOptional({
    example: false,
    description:
      'True when the thread already has a reply from the SE. All fields below are then absent.',
  })
  alreadyReplied?: boolean;

  @ApiPropertyOptional({
    description:
      'Stored scores from the original run. Only when alreadyReplied.',
  })
  summary?: {
    intent: string;
    productConfidence: number | null;
    clientHistoryConfidence: number | null;
    supervisorLabel: string | null;
  } | null;

  @ApiPropertyOptional({ type: ProcessEmailClassificationDto })
  classification?: ProcessEmailClassificationDto;

  @ApiPropertyOptional({ type: ProcessEmailConfidenceDto })
  confidence?: ProcessEmailConfidenceDto;

  @ApiPropertyOptional({
    description:
      'The composed reply. Null when a hallucination suppressed it — never assume a draft exists.',
  })
  draft?: { draftText: string } | null;

  @ApiPropertyOptional({
    description: 'Structured requirements from the Extractor. Null on failure.',
  })
  requirements?: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: ProcessEmailClientDto })
  client?: ProcessEmailClientDto;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'LangGraph thread id, for resuming with an edited draft.',
  })
  graphThreadId?: string | null;

  @ApiPropertyOptional({
    example: '2026-08-14T09:12:00.000Z',
    description:
      'When the email was received, from the message header — not when it was processed.',
  })
  emailTimestamp?: string;
}
