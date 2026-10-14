import { IsNotEmpty, IsString, IsEnum } from 'class-validator';
import { CrmProvider } from '../crm.constants';

export class ConnectCrmDto {
  @IsEnum(CrmProvider)
  @IsNotEmpty()
  provider!: CrmProvider;

  @IsString()
  @IsNotEmpty()
  apiKey!: string;
}
