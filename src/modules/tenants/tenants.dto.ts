import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SignupTenantDto {
  @IsString()
  @IsNotEmpty()
  companyName: string;

  @IsEmail()
  @IsNotEmpty()
  adminEmail: string;

  @IsString()
  @IsOptional()
  adminName?: string;
}

export class VerifyTenantDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class ResendVerificationDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsOptional()
  companyName?: string;
}
