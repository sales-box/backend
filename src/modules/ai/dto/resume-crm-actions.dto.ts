import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class CrmDecisionDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  type: 'approve' | 'reject';

  /**
   * Which proposed action this decision is for.
   *
   * Optional so a client that predates it still works — the backend then pairs
   * decisions to actions by position, exactly as before. Sending it is what
   * stops an approval binding to a list POSITION and silently re-targeting a
   * different action when the list changes underneath.
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  toolCallId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  message?: string;
}

export class ResumeCrmActionsDto {
  @ApiProperty({ description: 'Graph thread ID paused for approval' })
  @IsString()
  threadId: string;

  @ApiProperty({
    type: [CrmDecisionDto],
    description:
      'One approve/reject decision per proposed action. Carries toolCallId where the client supports it; otherwise matched by position.',
  })
  @IsArray()
  @ArrayNotEmpty()
  // The array was validated as an array and nothing more, so `[{}]` passed
  // straight through to the graph. main.ts already runs whitelist +
  // forbidNonWhitelisted; this is what makes it apply to the elements.
  @ValidateNested({ each: true })
  @Type(() => CrmDecisionDto)
  decisions: CrmDecisionDto[];
}
