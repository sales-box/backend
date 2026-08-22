import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class PlatformLoginDto {
  @ApiProperty({ example: 'ops@salesbox.dev' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: '••••••••' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
