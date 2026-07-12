import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SetAdminPasswordDto {
  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'correct-horse-battery-staple', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({
    description: 'Active tenant this admin belongs to',
    example: 'b3f8a1d2-4c5e-4f6a-9b7c-8d9e0f1a2b3c',
  })
  @IsUUID()
  tenantId!: string;
}
