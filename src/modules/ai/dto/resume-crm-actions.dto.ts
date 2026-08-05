import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class ResumeCrmActionsDto {
  @ApiProperty({ description: 'Graph thread ID paused for approval' })
  @IsString()
  threadId: string;

  @ApiProperty({
    description: 'Array of approve/reject decisions matching action indices',
  })
  @IsArray()
  decisions: Array<{ type: 'approve' | 'reject'; message?: string }>;
}
