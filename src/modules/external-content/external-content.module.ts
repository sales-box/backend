import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExternalContentController } from './external-content.controller';
import { ExternalContentService } from './external-content.service';
import { GoogleDriveResolver } from './resolvers/google-drive.resolver';
import { LinkDetectorResolver } from './resolvers/link-detector.resolver';
import { ExternalContentStorageService } from './storage/external-content-storage.service';

@Module({
  // AuthModule exports CryptoService (admin Drive token decryption). PrismaService
  // is @Global. Only the orchestrator is exposed to the rest of the app.
  imports: [AuthModule],
  controllers: [ExternalContentController],
  providers: [
    ExternalContentService,
    LinkDetectorResolver,
    GoogleDriveResolver,
    ExternalContentStorageService,
  ],
  exports: [ExternalContentService],
})
export class ExternalContentModule {}
