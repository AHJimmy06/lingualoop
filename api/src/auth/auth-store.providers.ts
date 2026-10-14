import type { Provider } from '@nestjs/common';
import { AccountStore, LINGUALOOP_ACCOUNT_STORE } from './account-store';
import { IdentityStore } from './identity-store';
import { RefreshStore } from './refresh-store';
import { SessionStore } from './session-store';
import { LINGUALOOP_QUERY_EXECUTOR } from '../db/postgres';

export const LINGUALOOP_APPROVAL_STORE = Symbol('LINGUALOOP_APPROVAL_STORE');
export const LINGUALOOP_IDENTITY_STORE = Symbol('LINGUALOOP_IDENTITY_STORE');
export const LINGUALOOP_OAUTH_STATE_STORE = Symbol('LINGUALOOP_OAUTH_STATE_STORE');
export const LINGUALOOP_SESSION_STORE = Symbol('LINGUALOOP_SESSION_STORE');
export const LINGUALOOP_REFRESH_STORE = Symbol('LINGUALOOP_REFRESH_STORE');

export const AUTH_STORE_PROVIDERS: Provider[] = [
  {
    provide: LINGUALOOP_ACCOUNT_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof AccountStore>[0]) => new AccountStore(executor),
  },
  {
    provide: LINGUALOOP_IDENTITY_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof IdentityStore>[0]) => new IdentityStore(executor),
  },
  {
    provide: LINGUALOOP_SESSION_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof SessionStore>[0]) => new SessionStore(executor),
  },
  {
    provide: LINGUALOOP_REFRESH_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof RefreshStore>[0]) => new RefreshStore(executor),
  },
];
