import { normalizeEmail, isAccountRole, type AccountRole } from './account-role';
import { validateAccountName } from './account-store';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  sessionId: string;
}

export interface AuthenticatedIdentity extends VerifiedIdentity {
  ownerId: string;
  name: string;
  email: string;
  role: AccountRole;
}

export interface BearerTokenVerifier {
  verifyBearerToken(token: string): Promise<VerifiedIdentity>;
}

export interface IdentityOwnerLookup {
  findOwnerByIdentity(identity: Pick<VerifiedIdentity, 'issuer' | 'subject'>): Promise<string | null>;
  findAccountByOwner(ownerId: string): Promise<{ name: string; email: string; role: AccountRole } | null>;
}

export interface ActiveSessionChecker {
  isSessionActive(ownerUuid: string, sessionUuid: string, nowMs: number): Promise<boolean>;
}

export class InvalidBearerTokenError extends Error {
  constructor() {
    super('Bearer token is invalid.');
    this.name = 'InvalidBearerTokenError';
  }
}

interface AuthenticatedRequest {
  headers?: { authorization?: string | string[] };
  rawHeaders?: string[];
  verifiedIdentity?: AuthenticatedIdentity;
}

const BEARER_HEADER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;
const LOCAL_ISSUER = 'local';
const MAX_SUBJECT_BYTES = 512;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class VerifiedRequestGuard implements CanActivate {
  constructor(
    private readonly verifier?: BearerTokenVerifier,
    private readonly ownerLookup?: IdentityOwnerLookup,
    private readonly sessionChecker?: ActiveSessionChecker,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse?.<{ setHeader?: (name: string, value: string) => void }>();
    // Authentication failures and private account/report responses must never be shared-cache entries.
    if (typeof response?.setHeader === 'function') {
      response.setHeader('Cache-Control', 'private, no-store, max-age=0');
      response.setHeader('Pragma', 'no-cache');
    }
    delete request.verifiedIdentity;
    const token = this.extractBearerToken(request);

    if (!this.verifier || typeof this.verifier.verifyBearerToken !== 'function' ||
        !this.ownerLookup || typeof this.ownerLookup.findOwnerByIdentity !== 'function' ||
        typeof this.ownerLookup.findAccountByOwner !== 'function' ||
        !this.sessionChecker || typeof this.sessionChecker.isSessionActive !== 'function') {
      throw new HttpException('Authentication service unavailable.', 503);
    }

    let identity: unknown;
    try {
      identity = await this.verifier.verifyBearerToken(token);
    } catch (error) {
      if (error instanceof InvalidBearerTokenError) {
        throw new HttpException('Unauthorized.', 401);
      }
      throw new HttpException('Authentication service unavailable.', 503);
    }

    if (!this.isVerifiedIdentity(identity)) {
      throw new HttpException('Authentication service unavailable.', 503);
    }

    let ownerId: unknown;
    try {
      ownerId = await this.ownerLookup.findOwnerByIdentity({ issuer: identity.issuer, subject: identity.subject });
    } catch {
      throw new HttpException('Authentication service unavailable.', 503);
    }
    if (ownerId === null) throw new HttpException('Unauthorized.', 401);
    if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) {
      throw new HttpException('Authentication service unavailable.', 503);
    }

    const nowMs = this.nowMs();
    let active: unknown;
    try {
      active = await this.sessionChecker.isSessionActive(ownerId, identity.sessionId, nowMs);
    } catch {
      throw new HttpException('Authentication service unavailable.', 503);
    }
    if (typeof active !== 'boolean') throw new HttpException('Authentication service unavailable.', 503);
    if (!active) throw new HttpException('Unauthorized.', 401);

    let approval;
    try {
      approval = await this.ownerLookup.findAccountByOwner(ownerId);
      if (approval) validateAccountName(approval.name);
      if (approval !== null && (!approval || normalizeEmail(approval.email) !== approval.email || !isAccountRole(approval.role))) {
        throw new Error();
      }
    } catch { throw new HttpException('Authentication service unavailable.', 503); }
    if (approval === null) throw new HttpException('Forbidden.', 403);

    // Never propagate role/email claims (or any other fields) from the bearer verifier.
    request.verifiedIdentity = {
      issuer: identity.issuer, subject: identity.subject, sessionId: identity.sessionId,
      ownerId, name: approval.name, email: approval.email, role: approval.role,
    };
    return true;
  }

  private extractBearerToken(request: AuthenticatedRequest): string {
    const authorization = request.headers?.authorization;
    if (Array.isArray(authorization) || typeof authorization !== 'string') {
      throw new HttpException('Unauthorized.', 401);
    }

    const rawHeaders = request.rawHeaders;
    if (Array.isArray(rawHeaders)) {
      let authorizationCount = 0;
      for (let index = 0; index < rawHeaders.length; index += 2) {
        if (rawHeaders[index]?.toLowerCase() === 'authorization') authorizationCount += 1;
      }
      if (authorizationCount !== 1) throw new HttpException('Unauthorized.', 401);
    }

    const match = BEARER_HEADER_PATTERN.exec(authorization);
    if (!match) throw new HttpException('Unauthorized.', 401);
    return match[1];
  }

  private isVerifiedIdentity(value: unknown): value is VerifiedIdentity {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const identity = value as Record<string, unknown>;
    const { issuer, subject, sessionId } = identity;
    return issuer === LOCAL_ISSUER && typeof subject === 'string' && UUID_PATTERN.test(subject) &&
      Buffer.byteLength(subject, 'utf8') <= MAX_SUBJECT_BYTES &&
      Buffer.from(subject, 'utf8').toString('utf8') === subject && subject.normalize('NFC') === subject &&
      !/[\p{White_Space}\p{Cc}\p{Cf}]/u.test(subject) &&
      typeof sessionId === 'string' && UUID_V4_PATTERN.test(sessionId);
  }
}
