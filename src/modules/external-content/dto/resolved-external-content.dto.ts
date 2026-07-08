import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger view of ResolvedExternalContent (one per detected link). */
export class ResolvedExternalContentDto {
  @ApiProperty({ enum: ['google_drive', 'unknown_link'] })
  sourceType!: 'google_drive' | 'unknown_link';

  @ApiProperty({ example: 'https://docs.google.com/document/d/FILE_ID/edit' })
  originalRef!: string;

  @ApiProperty({ example: 'docs.google.com' })
  domain!: string;

  @ApiProperty()
  fetched!: boolean;

  @ApiPropertyOptional({
    description: 'S3 key, present only when bytes were stored',
    example: 'resolved/test-interaction-1/FILE_ID-abcd1234.pdf',
  })
  rawStorageKey?: string;

  @ApiProperty()
  skipped!: boolean;

  @ApiPropertyOptional({
    enum: [
      'unrecognized_domain',
      'fetch_failed',
      'parse_error',
      'not_attempted',
    ],
  })
  reason?: string;
}
