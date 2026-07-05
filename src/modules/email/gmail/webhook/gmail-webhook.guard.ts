import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GmailWebhookGuard implements CanActivate {
  private readonly verificationToken: string;

  constructor(private readonly configService: ConfigService) {
    this.verificationToken = this.configService.getOrThrow<string>(
      'GOOGLE_PUBSUB_VERIFICATION_TOKEN',
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ query: { token?: string } }>();
    const token = request.query.token as string;

    if (token !== this.verificationToken) {
      throw new UnauthorizedException('Invalid webhook verification token');
    }

    return true;
  }
}
