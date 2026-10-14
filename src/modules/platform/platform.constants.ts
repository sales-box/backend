/** The role claim that marks a JWT as a platform-operator token. */
export const PLATFORM_JWT_ROLE = 'platform' as const;

/**
 * Claims carried by a platform-operator JWT.
 *
 * Deliberately has NO `tenantId` and NO `isAdmin` — platform operators act
 * across tenants and must never satisfy a tenant guard (AdminTenantGuard rejects
 * a payload without a tenantId). Signed by the same JwtModule as tenant tokens,
 * so a tenant can't forge one, and the `role` claim is what PlatformGuard checks.
 */
export interface PlatformJwtPayload {
  /** PlatformAdmin id. */
  sub: string;
  role: typeof PLATFORM_JWT_ROLE;
  email: string;
}
