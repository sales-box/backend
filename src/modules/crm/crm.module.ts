import { Module, forwardRef } from '@nestjs/common';
import { CrmService } from './crm.service';
import { CrmController } from './crm.controller';
import { AuthModule } from '../auth/auth.module';
import { ClientsModule } from '../clients/clients.module';

@Module({
  imports: [AuthModule, forwardRef(() => ClientsModule)],
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule {}
