const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GoogleIdentityService,
  InvalidGoogleIdTokenError,
} = require('../dist/auth/google-identity.service.js');

const AUDIENCE = 'lingualoop-client.apps.googleusercontent.com';
const FUTURE_EXPIRY = Math.floor(Date.now() / 1_000) + 300;

function payload(overrides = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: 'google-stable-subject-123',
    exp: FUTURE_EXPIRY,
    ...overrides,
  };
}

function service(ticketPayload, onVerify = () => {}) {
  return new GoogleIdentityService(AUDIENCE, async (token, audience) => {
    onVerify(token, audience);
    return ticketPayload;
  });
}

async function rejectsAsInvalid(promise) {
  await assert.rejects(promise, InvalidGoogleIdTokenError);
}

test('verifies with the expected audience and returns only Google issuer and stable subject', async () => {
  let observed;
  const identity = await service(payload({ email: 'person@example.test', email_verified: true }),
    (token, audience) => { observed = { token, audience }; }).verify('offline-test-ticket');

  assert.deepEqual(observed, { token: 'offline-test-ticket', audience: AUDIENCE });
  assert.deepEqual(identity, { issuer: 'google', subject: 'google-stable-subject-123' });
});

test('accepts the legacy Google issuer spelling', async () => {
  assert.deepEqual(await service(payload({ iss: 'accounts.google.com' })).verify('ticket'), {
    issuer: 'google',
    subject: 'google-stable-subject-123',
  });
});

test('rejects untrusted issuers and a wrong audience', async () => {
  await rejectsAsInvalid(service(payload({ iss: 'https://attacker.example' })).verify('ticket'));
  await rejectsAsInvalid(service(payload({ aud: 'another-client' })).verify('ticket'));
});

test('rejects an unverified email when an email claim is present', async () => {
  await rejectsAsInvalid(service(payload({ email: 'person@example.test', email_verified: false })).verify('ticket'));
});

test('rejects a missing or malformed stable subject', async () => {
  for (const sub of [undefined, '', 'subject with whitespace', `x${'x'.repeat(512)}`]) {
    await rejectsAsInvalid(service(payload({ sub })).verify('ticket'));
  }
});

test('rejects expired tickets and tickets rejected by the Google verifier', async () => {
  await rejectsAsInvalid(service(payload({ exp: Math.floor(Date.now() / 1_000) - 1 })).verify('ticket'));
  await rejectsAsInvalid(new GoogleIdentityService(AUDIENCE, async () => {
    throw new Error('signature or ticket validation failed');
  }).verify('invalid-ticket'));
});

test('rejects malformed and oversized ticket strings', async () => {
  const validService = service(payload());
  await rejectsAsInvalid(validService.verify(''));
  await rejectsAsInvalid(validService.verify('x'.repeat(16_385)));
});
