import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

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
}
