import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { TokenService } from './token.service';
import { AllowlistModule } from '../allowlist/allowlist.module';

@Module({
  controllers: [AuthController],
  imports: [AllowlistModule],
  providers: [AuthService, CryptoService, TokenService],
  exports: [AuthService, CryptoService],
})
export class AuthModule {}
