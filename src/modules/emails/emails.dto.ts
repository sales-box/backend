import { IsEmail, IsNotEmpty } from 'class-validator';

export class GetThreadHistoryDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}
