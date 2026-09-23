import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
}

export interface BearerTokenVerifier {
  verifyBearerToken(token: string): Promise<VerifiedIdentity>;
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
  verifiedIdentity?: VerifiedIdentity;
}

const BEARER_HEADER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

@Injectable()
export class VerifiedRequestGuard implements CanActivate {
  constructor(private readonly verifier?: BearerTokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    delete request.verifiedIdentity;
    const token = this.extractBearerToken(request);

    if (!this.verifier || typeof this.verifier.verifyBearerToken !== 'function') {
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

    request.verifiedIdentity = { issuer: identity.issuer, subject: identity.subject };
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
    if (typeof value !== 'object' || value === null) return false;
    const identity = value as Record<string, unknown>;
    return typeof identity.issuer === 'string' && identity.issuer.trim().length > 0 &&
      typeof identity.subject === 'string' && identity.subject.trim().length > 0;
  }
}
