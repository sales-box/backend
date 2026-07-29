import { IsNotEmpty, IsString } from 'class-validator';

export class ResumeGraphDto {
  @IsString()
  @IsNotEmpty()
  graphThreadId!: string;

  @IsString()
  @IsNotEmpty()
  content!: string;
}
