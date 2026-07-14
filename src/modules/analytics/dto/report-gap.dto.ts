import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReportGapDto {
  @ApiProperty({
    description: 'The topic/subject of the missing knowledge gap',
    maxLength: 500,
    example: 'pricing for enterprise plan',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  topic!: string;
}
