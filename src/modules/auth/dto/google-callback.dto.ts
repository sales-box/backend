import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** Query parameters Google sends back to the OAuth callback. */
export class GoogleCallbackDto {
  @ApiPropertyOptional({ description: 'Authorization code returned by Google' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ description: 'CSRF state echoed back by Google' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({
    description: 'Error code when the user denies consent',
  })
  @IsOptional()
  @IsString()
  error?: string;

  @ApiPropertyOptional({ description: 'Granted scopes echoed by Google' })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional({ description: 'Google issuer identifier' })
  @IsOptional()
  @IsString()
  iss?: string;

  @ApiPropertyOptional({ description: 'Index of the chosen Google account' })
  @IsOptional()
  @IsString()
  authuser?: string;

  @ApiPropertyOptional({ description: 'Google Workspace hosted domain' })
  @IsOptional()
  @IsString()
  hd?: string;

  @ApiPropertyOptional({ description: 'Consent prompt echoed by Google' })
  @IsOptional()
  @IsString()
  prompt?: string;
}
