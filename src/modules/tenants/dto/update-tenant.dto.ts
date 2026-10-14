import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateTenantDto {
  @ApiPropertyOptional({
    description: 'The company name of the tenant',
    maxLength: 200,
    example: 'Acme Corp',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  companyName?: string;
}
