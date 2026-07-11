import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../auth/crypto.service';
import { ICrmAdapter } from './crm.interface';
import { HubSpotAdapter } from './hubspot-crm.adapter';
import { MockCrmAdapter } from './mock-crm.adapter';
import { CrmProvider } from './crm.constants';

@Injectable()
export class CrmAdapterFactory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  async getAdapterForTenant(tenantId: string): Promise<ICrmAdapter | null> {
    const globalProvider = this.config.get<string>('CRM_PROVIDER');
    if (globalProvider === CrmProvider.Mock) {
      return new MockCrmAdapter();
    }

    const connection = await this.prisma.crmConnection.findUnique({
      where: { tenantId },
    });

    if (!connection || connection.status !== 'connected') {
      return null;
    }

    if (connection.provider === (CrmProvider.Mock as string)) {
      return new MockCrmAdapter();
    }

    if (connection.provider === (CrmProvider.HubSpot as string)) {
      const decryptedKey = this.crypto.decrypt(connection.apiKey);
      return new HubSpotAdapter(decryptedKey);
    }

    return null;
  }
}
