// Minimal type shim for `jsonwebtoken`.
//
// TECH DEBT: `@types/jsonwebtoken` could not be installed because pnpm/corepack
// is broken in this environment. `jsonwebtoken` itself is present and is the
// exact library `@nestjs/jwt` wraps. Once the package manager works, add
// `@nestjs/jwt` (or `@types/jsonwebtoken`) and delete this file.
//
// Only the small surface we actually use is declared here.
declare module 'jsonwebtoken' {
  export interface SignOptions {
    expiresIn?: string | number;
  }
  export function sign(
    payload: string | object | Buffer,
    secretOrPrivateKey: string,
    options?: SignOptions,
  ): string;
  export function verify(token: string, secretOrPublicKey: string): unknown;
}
