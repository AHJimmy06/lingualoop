import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { normalizeEmail } from './account-role';
import type { VerifiedIdentity } from './identity-store';

const MICROSOFT_JWKS = createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'));
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MicrosoftIdentityService {
  constructor(private readonly audience: string, private readonly now: () => number = Date.now,
    private readonly request: typeof fetch = fetch) {
    if (!audience || !audience.trim()) throw new TypeError('A Microsoft client ID is required.');
  }
  async verify(idToken: string, expectedNonce?: string, accessToken?: string): Promise<VerifiedIdentity> {
    try {
      if (typeof idToken !== 'string' || idToken.length > 16_384 || !expectedNonce ||
          typeof accessToken !== 'string' || accessToken.length > 8192) throw new Error();
      const untrusted = decodeJwt(idToken);
      if (typeof untrusted.tid !== 'string' || !TENANT_ID.test(untrusted.tid)) throw new Error();
      const issuer = `https://login.microsoftonline.com/${untrusted.tid}/v2.0`;
      const { payload, protectedHeader } = await jwtVerify(idToken, MICROSOFT_JWKS, {
        issuer, audience: this.audience, algorithms: ['RS256'], clockTolerance: 5,
        currentDate: new Date(this.now()),
      });
      if (protectedHeader.alg !== 'RS256' || payload.nonce !== expectedNonce || typeof payload.sub !== 'string' ||
          !payload.sub.trim() || Buffer.byteLength(payload.sub, 'utf8') > 512) throw new Error();
      // Microsoft email/preferred_username claims aren't guaranteed to be authoritative.
      // Resolve the signed-in user's profile with the delegated User.Read token instead.
      const profileResponse = await this.request('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      if (!profileResponse.ok) throw new Error();
      const profile: unknown = await profileResponse.json();
      if (!profile || typeof profile !== 'object') throw new Error();
      const row = profile as { id?: unknown; mail?: unknown; userPrincipalName?: unknown; displayName?: unknown };
      if (typeof row.id !== 'string' || !row.id.trim() || (typeof payload.oid === 'string' && payload.oid !== row.id)) throw new Error();
      const email = normalizeEmail(row.mail || row.userPrincipalName);
      return { issuer: 'microsoft', subject: payload.sub, email, ...(typeof row.displayName === 'string' && row.displayName.trim() ? { name: row.displayName.trim().slice(0, 120) } : {}) };
    } catch { throw new Error('Microsoft ID token is invalid.'); }
  }
}
