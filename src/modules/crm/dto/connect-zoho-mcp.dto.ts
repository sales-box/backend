import { IsNotEmpty, IsString, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ConnectZohoMcpDto {
  @ApiProperty({
    description: 'Presigned Zoho MCP Server URL',
    example:
      'https://crm-data-metadata-933559385.zohomcp.com/mcp/faa48fb0a1ddbdc39449cdbab2502224/message',
  })
  @IsString()
  @IsNotEmpty()
  @IsUrl()
  mcpServerUrl!: string;
}
