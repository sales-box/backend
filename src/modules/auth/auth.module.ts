import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AllowlistModule } from '../allowlist/allowlist.module';

@Module({
  imports: [
    // SE login validates the caller against the tenant allowlist before
    // issuing a token. forwardRef breaks the Auth↔Allowlist cycle (the
    // allowlist controller needs JwtAuthGuard from here).
    forwardRef(() => AllowlistModule),
    // Single JWT engine for the whole app: admin login, SE login, and the
    // JwtAuthGuard all sign/verify through this one configuration.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        // expiresIn accepts a vercel/ms string ("1h", "7d") or seconds.
        signOptions: {
          expiresIn: config.getOrThrow<string>(
            'JWT_EXPIRES_IN',
          ) as `${number}${'s' | 'm' | 'h' | 'd'}`,
        },
      }),
    }),
  ],
  controllers: [AuthController, AdminAuthController],
  providers: [AuthService, CryptoService, AdminAuthService, JwtAuthGuard],
  // JwtModule is exported so modules importing AuthModule can apply JwtAuthGuard.
  exports: [
    AuthService,
    CryptoService,
    AdminAuthService,
    JwtAuthGuard,
    JwtModule,
  ],
})
export class AuthModule {}
