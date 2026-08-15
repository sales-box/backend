import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReportGapDto {
  @ApiProperty({
    description:
      'Gmail message id. The server derives a deterministic topic from its tenant-scoped Interaction.',
    maxLength: 500,
    example: '18f2a77b9123abcd',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  messageId!: string;
}
