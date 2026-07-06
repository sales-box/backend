import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CRM_ADAPTER, CrmProvider } from './crm.constants';
import { ICrmAdapter } from './crm.interface';
import { HubSpotAdapter } from './hubspot-crm.adapter';
import { MockCrmAdapter } from './mock-crm.adapter';

export const crmAdapterProvider: Provider = {
  provide: CRM_ADAPTER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): ICrmAdapter => {
    const provider = config.get<CrmProvider>('CRM_PROVIDER', CrmProvider.Mock);
    const logger = new Logger('CrmAdapter');

    if (provider === CrmProvider.HubSpot) {
      logger.log('Using HubSpotAdapter');
      return new HubSpotAdapter(config);
    }

    logger.log('Using MockCrmAdapter');
    return new MockCrmAdapter();
  },
};
