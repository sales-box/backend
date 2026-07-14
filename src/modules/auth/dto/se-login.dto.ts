import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SeLoginDto {
  @ApiProperty({
    description: 'Google OAuth authorization code from the extension popup',
  })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiPropertyOptional({
    description:
      'The exact redirect URI used to obtain the code (required for SE extension flow)',
  })
  @IsString()
  @IsOptional()
  redirectUri?: string;
}
