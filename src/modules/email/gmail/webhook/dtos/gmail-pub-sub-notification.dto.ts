import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

class GmailPubSubMessage {
  @IsString()
  data: string;

  @IsString()
  messageId: string;

  @IsString()
  @IsOptional()
  message_id?: string;

  @IsString()
  @IsOptional()
  publishTime?: string;

  @IsString()
  @IsOptional()
  publish_time?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
}

export class GmailPubSubNotificationDto {
  @IsString()
  subscription: string;

  @IsObject()
  @ValidateNested()
  @Type(() => GmailPubSubMessage)
  message: GmailPubSubMessage;
}
