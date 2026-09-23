import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InvalidBearerTokenError } from './verified-request.guard';

export const LINGUALOOP_TOKEN_SIGNING_KEY = Symbol('LINGUALOOP_TOKEN_SIGNING_KEY');

const TOKEN_ISSUER = 'lingualoop';
const TOKEN_AUDIENCE = 'lingualoop-api';
const TOKEN_TTL_SECONDS = 15 * 60;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_SUBJECT_BYTES = 512;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const INVALID_TOKEN = new InvalidBearerTokenError();

export interface LinguaLoopIdentity {
  issuer: string;
  subject: string;
}

export interface IssueLinguaLoopTokenInput {
  issuer: string;
  subject: string;
}

interface LinguaLoopTokenClaims {
  sub?: unknown;
  provider?: unknown;
  iat?: unknown;
  exp?: unknown;
}

@Injectable()
export class LinguaLoopTokenService {
  private readonly signingKey: Buffer | string;

  constructor(
    private readonly jwtService: JwtService,
    @Inject(LINGUALOOP_TOKEN_SIGNING_KEY) signingKey: Buffer | string,
  ) {
    if (!Buffer.isBuffer(signingKey) && typeof signingKey !== 'string') {
      throw new TypeError('A LinguaLoop token signing key is required.');
    }
    const keyBytes = Buffer.isBuffer(signingKey) ? Buffer.from(signingKey) : Buffer.from(signingKey, 'utf8');
    if (keyBytes.length < 32) {
      throw new TypeError('The LinguaLoop token signing key must be at least 32 bytes.');
    }
    this.signingKey = keyBytes;
  }

  async issue(input: IssueLinguaLoopTokenInput): Promise<string> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new RangeError('A provider issuer and subject are required.');
    }
    const { issuer, subject } = input;
    this.validateIssuer(issuer);
    this.validateSubject(subject);

    return this.jwtService.signAsync(
      { provider: issuer },
      {
        algorithm: 'HS256',
        audience: TOKEN_AUDIENCE,
        expiresIn: TOKEN_TTL_SECONDS,
        issuer: TOKEN_ISSUER,
        secret: this.signingKey,
        subject,
      },
    );
  }

  async verifyBearerToken(token: string): Promise<LinguaLoopIdentity> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !BEARER_TOKEN_PATTERN.test(token)) {
      throw INVALID_TOKEN;
    }

    try {
      const claims = await this.jwtService.verifyAsync<LinguaLoopTokenClaims>(token, {
        algorithms: ['HS256'],
        audience: TOKEN_AUDIENCE,
        issuer: TOKEN_ISSUER,
        secret: this.signingKey,
      });
      if (!claims || typeof claims !== 'object') throw INVALID_TOKEN;
      if (
        typeof claims.iat !== 'number' ||
        !Number.isSafeInteger(claims.iat) ||
        typeof claims.exp !== 'number' ||
        !Number.isSafeInteger(claims.exp) ||
        (claims.exp as number) <= (claims.iat as number) ||
        (claims.exp as number) - (claims.iat as number) > TOKEN_TTL_SECONDS
      ) {
        throw INVALID_TOKEN;
      }
      this.validateIssuer(claims.provider);
      this.validateSubject(claims.sub);
      return { issuer: claims.provider, subject: claims.sub };
    } catch {
      throw INVALID_TOKEN;
    }
  }

  private validateIssuer(issuer: unknown): asserts issuer is string {
    if (typeof issuer !== 'string' || !PROVIDER_PATTERN.test(issuer)) {
      throw new RangeError('issuer must be a stable provider identifier.');
    }
  }

  private validateSubject(subject: unknown): asserts subject is string {
    if (
      typeof subject !== 'string' ||
      subject.length === 0 ||
      Buffer.byteLength(subject, 'utf8') > MAX_SUBJECT_BYTES ||
      Buffer.from(subject, 'utf8').toString('utf8') !== subject ||
      subject.normalize('NFC') !== subject ||
      /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(subject)
    ) {
      throw new RangeError('subject must be a stable, well-formed provider identifier.');
    }
  }
}
