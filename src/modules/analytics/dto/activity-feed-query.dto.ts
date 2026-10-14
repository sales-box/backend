import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ActivityFeedQueryDto {
  @ApiPropertyOptional({
    description: 'The page number to retrieve, starting at 1',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'The number of activity items to retrieve per page',
    default: 50,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({
    description:
      'The calendar date (in YYYY-MM-DD or ISO string) to filter activities. Defaults to today.',
    example: '2026-07-14',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
