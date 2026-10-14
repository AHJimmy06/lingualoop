import { Body, Controller, Get, HttpException, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AccountStore, DuplicateAccountError, LINGUALOOP_ACCOUNT_STORE, validateAccountInput } from './account-store';
import { ConfiguredVerifiedRequestGuard } from './google-auth.providers';
import { RoleGuard, Roles } from './role.guard';
import type { AuthenticatedIdentity } from './verified-request.guard';

@Controller('auth')
@UseGuards(ConfiguredVerifiedRequestGuard)
export class CurrentAccountController {
  @Get('me')
  me(@Req() request: { verifiedIdentity: AuthenticatedIdentity }) {
    const { ownerId, name, email, role } = request.verifiedIdentity;
    return { ownerId, name, email, role };
  }
}

@Controller('admin/accounts')
@UseGuards(ConfiguredVerifiedRequestGuard, RoleGuard)
@Roles('admin')
export class AdminAccountsController {
  constructor(@Inject(LINGUALOOP_ACCOUNT_STORE) private readonly store: AccountStore) {}
  @Post()
  async create(@Body() body: unknown) {
    let input;
    try { input = validateAccountInput(body); } catch { throw new HttpException('Invalid account.', 400); }
    try { return await this.store.create(input); }
    catch (error) {
      if (error instanceof DuplicateAccountError) throw new HttpException('Account already exists.', 409);
      throw new HttpException('Account service unavailable.', 503);
    }
  }
  @Get()
  async list() {
    try { return { accounts: await this.store.list() }; }
    catch { throw new HttpException('Account service unavailable.', 503); }
  }
}
