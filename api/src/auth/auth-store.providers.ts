import type { Provider } from '@nestjs/common';
import { IdentityStore } from './identity-store';
import { OAuthStateDbStore } from './oauth-state-db';
import { RefreshStore } from './refresh-store';
import { SessionStore } from './session-store';
import { LINGUALOOP_QUERY_EXECUTOR } from '../db/postgres';

export const LINGUALOOP_IDENTITY_STORE = Symbol('LINGUALOOP_IDENTITY_STORE');
export const LINGUALOOP_OAUTH_STATE_STORE = Symbol('LINGUALOOP_OAUTH_STATE_STORE');
export const LINGUALOOP_SESSION_STORE = Symbol('LINGUALOOP_SESSION_STORE');
export const LINGUALOOP_REFRESH_STORE = Symbol('LINGUALOOP_REFRESH_STORE');

export const AUTH_STORE_PROVIDERS: Provider[] = [
  {
    provide: LINGUALOOP_IDENTITY_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof IdentityStore>[0]) => new IdentityStore(executor),
  },
  {
    provide: LINGUALOOP_OAUTH_STATE_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof OAuthStateDbStore>[0]) => new OAuthStateDbStore(executor),
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
