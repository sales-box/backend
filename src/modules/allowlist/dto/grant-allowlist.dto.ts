import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class GrantAllowlistDto {
  @ApiProperty()
  @IsEmail()
  email!: string;
}
