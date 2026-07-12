import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SeLoginDto {
  @ApiProperty({
    description: 'Google OAuth authorization code from the extension popup',
  })
  @IsString()
  @IsNotEmpty()
  code!: string;
}
