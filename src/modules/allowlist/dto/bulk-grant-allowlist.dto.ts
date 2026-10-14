import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';
import { MAX_BULK_EMAILS } from '../allowlist.constants';

export class BulkGrantAllowlistDto {
  /**
   * Deliberately typed as plain strings rather than @IsEmail({ each: true }).
   * A bulk paste is expected to contain junk, and class-validator would reject
   * the WHOLE request over one bad row — the admin would lose 49 good addresses
   * to one typo with no clue which row was at fault. The service validates each
   * address itself and reports the bad ones back per row.
   */
  @ApiProperty({
    type: [String],
    example: ['ali@acme.com', 'sara@acme.com'],
    description:
      'Email addresses to grant. Invalid entries are reported per row, not rejected wholesale.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_EMAILS)
  @IsString({ each: true })
  emails!: string[];
}
