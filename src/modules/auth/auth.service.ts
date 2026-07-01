import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

@Injectable()
export class AuthService {
  constructor(private readonly config: ConfigService) {}

  buildGoogleAuthUrl(): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);

    url.search = new URLSearchParams({
      client_id: this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      redirect_uri: this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
      response_type: 'code',
      scope: this.config.getOrThrow<string>('GOOGLE_SCOPES'),
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

    return url.toString();
  }
}
