import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class ResolveExternalContentDto {
  @ApiProperty({
    description: 'Plain-text email body to scan for external links',
    example: 'Please review https://docs.google.com/document/d/FILE_ID/edit',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_000_000)
  emailBody!: string;

  @ApiProperty({
    description:
      'The interaction this content belongs to (used in the storage key)',
    example: 'test-interaction-1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  interactionId!: string;

  @ApiPropertyOptional({
    description:
      'Tenant whose allow-list and Drive connection are used. Temporary: will be derived from the admin JWT once Admin Auth lands.',
    example: 'b3f8a1d2-4c5e-4f6a-9b7c-8d9e0f1a2b3c',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
