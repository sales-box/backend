import { IsNotEmpty, IsString } from 'class-validator';

export class ProcessEmailDto {
  @IsString()
  @IsNotEmpty()
  messageId!: string; // Gmail message ID — same ID GeneralAnalysis.messageId is stored under

  @IsString()
  @IsNotEmpty()
  accountEmail!: string; // Connected Gmail account the email lives in (NOT the client's email)
}
