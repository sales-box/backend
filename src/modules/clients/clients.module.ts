import { Module, forwardRef } from '@nestjs/common';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { CrmModule } from '../crm/crm.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => CrmModule), AuthModule],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
