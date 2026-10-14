const test = require('node:test');
const assert = require('node:assert/strict');
const { PasswordLoginSession, InvalidCredentialsError } = require('../../dist/auth/password-login-session.js');
const ID = '123e4567-e89b-42d3-a456-426614174000';
const SID = '223e4567-e89b-42d3-a456-426614174000';
function fixture({ admitted = true, initialize = true, signing = true } = {}) {
  const calls = [];
  const service = new PasswordLoginSession({ async authenticate() { calls.push('authenticate'); return admitted ? ID : null; } },
    { async createSession(owner, expiry) { calls.push(['create', owner, expiry]); return SID; }, async revokeSession(owner, session) { calls.push(['revoke', owner, session]); } },
    { async initialize(owner, session, hash) { calls.push(['initialize', owner, session, hash]); return initialize; } },
    { async issue(identity) { calls.push(['sign', identity]); if (!signing) throw Error('PRIVATE'); return 'signed'; } });
  return { service, calls };
}
test('invalid credentials never create sessions; valid issuance signs local identity and provides delivery compensation', async () => {
  const denied = fixture({ admitted: false });
  await assert.rejects(denied.service.issue('user@example.test', 'password'), InvalidCredentialsError);
  assert.deepEqual(denied.calls, ['authenticate']);
  const f = fixture(); const result = await f.service.issue('user@example.test', 'password');
  assert.equal(Object.hasOwn(result, 'accessToken'), false);
  assert.match(result.refreshCredential, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.calls.find(c => c[0] === 'sign'), ['sign', { issuer: 'local', subject: ID, sessionId: SID }]);
  await result.compensateDeliveryFailure();
  assert.deepEqual(f.calls.at(-1), ['revoke', ID, SID]);
});
test('failed refresh initialization or signing revokes the created session and returns no credential', async () => {
  for (const options of [{ initialize: false }, { signing: false }]) {
    const f = fixture(options);
    await assert.rejects(f.service.issue('user@example.test', 'password'), error => error.message === 'Login service unavailable.');
    assert.deepEqual(f.calls.at(-1), ['revoke', ID, SID]);
  }
});
