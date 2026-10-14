import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentStatus } from '@prisma/client';

export class UploadResponseDto {
  @ApiProperty({ example: 'pricing.pdf' })
  filename!: string;

  @ApiProperty({
    example: 12,
    description: 'Number of chunks created and stored',
  })
  chunksCreated!: number;

  @ApiProperty({ enum: DocumentStatus, example: DocumentStatus.completed })
  status!: DocumentStatus;

  @ApiProperty({
    example: false,
    description:
      'Quality gate: true when extraction looks unreliable (e.g. a scanned PDF with almost no text)',
  })
  isLowConfidence!: boolean;

  @ApiPropertyOptional({
    example: 'Very little extractable text (42 characters)',
    description: 'Why the document was flagged (present when isLowConfidence)',
  })
  qualityReason?: string;
}
