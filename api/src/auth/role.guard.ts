import { CanActivate, ExecutionContext, HttpException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccountRole } from './account-role';
import type { AuthenticatedIdentity } from './verified-request.guard';

const ROLE_METADATA = 'lingualoop:roles';
export const Roles = (...roles: AccountRole[]) => SetMetadata(ROLE_METADATA, roles);

/** Always run after ConfiguredVerifiedRequestGuard; absence of policy fails closed. */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<AccountRole[]>(ROLE_METADATA, [context.getHandler(), context.getClass()]);
    const identity = context.switchToHttp().getRequest<{ verifiedIdentity?: AuthenticatedIdentity }>().verifiedIdentity;
    if (!identity) throw new HttpException('Unauthorized.', 401);
    if (!roles?.includes(identity.role)) throw new HttpException('Forbidden.', 403);
    return true;
  }
}
