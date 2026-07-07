import { ApiProperty } from '@nestjs/swagger';
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
}
