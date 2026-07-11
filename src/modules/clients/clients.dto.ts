import { PaginationQueryDto } from '@/common/dto/pagination-query.dto';
import {
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateClientDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  company?: string;
}

export class CreateInteractionDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsString()
  @IsNotEmpty()
  subject!: string;

  @IsString()
  @IsNotEmpty()
  aiSummary!: string;

  @IsString()
  @IsOptional()
  classification?: string;

  @IsNumber()
  @IsOptional()
  productConfidence?: number;

  @IsNumber()
  @IsOptional()
  clientHistoryConfidence?: number;

  @IsString()
  @IsOptional()
  recommendation?: string;
}

export class GetClientsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;
}
