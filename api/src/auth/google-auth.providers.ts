import { Inject, Injectable } from '@nestjs/common';
import { LinguaLoopTokenService } from './lingualoop-token.service';
import { VerifiedRequestGuard, type IdentityOwnerLookup } from './verified-request.guard';
import { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } from './auth-store.providers';

// Stable import locations for existing protected routes; no Google providers or configuration.
export const GOOGLE_AUTH_FLOW = Symbol('GOOGLE_AUTH_FLOW');
export const REFRESH_SESSION = Symbol('REFRESH_SESSION');

@Injectable()
export class ConfiguredVerifiedRequestGuard extends VerifiedRequestGuard {
  constructor(
    @Inject(LinguaLoopTokenService) verifier: LinguaLoopTokenService,
    @Inject(LINGUALOOP_IDENTITY_STORE) owners: IdentityOwnerLookup,
    @Inject(LINGUALOOP_SESSION_STORE) sessions: { isSessionActive(ownerId: string, sessionId: string, nowMs: number): Promise<boolean> },
  ) { super(verifier, owners, sessions); }
}
