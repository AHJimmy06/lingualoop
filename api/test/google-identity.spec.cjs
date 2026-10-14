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
    email: 'person@example.test',
    email_verified: true,
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

test('verifies with the expected audience and returns verified normalized email', async () => {
  let observed;
  const identity = await service(payload({ email: 'person@example.test', email_verified: true }),
    (token, audience) => { observed = { token, audience }; }).verify('offline-test-ticket');

  assert.deepEqual(observed, { token: 'offline-test-ticket', audience: AUDIENCE });
  assert.deepEqual(identity, { issuer: 'google', subject: 'google-stable-subject-123', email: 'person@example.test' });
});

test('accepts the legacy Google issuer spelling', async () => {
  assert.deepEqual(await service(payload({ iss: 'accounts.google.com' })).verify('ticket'), {
    issuer: 'google',
    subject: 'google-stable-subject-123',
    email: 'person@example.test',
  });
});

test('rejects untrusted issuers and a wrong audience', async () => {
  await rejectsAsInvalid(service(payload({ iss: 'https://attacker.example' })).verify('ticket'));
  await rejectsAsInvalid(service(payload({ aud: 'another-client' })).verify('ticket'));
});

test('requires email and strict boolean verified claim after ticket verification', async () => {
  for (const email_verified of [undefined, false, 'true', 1, null]) {
    await rejectsAsInvalid(service(payload({ email_verified })).verify('ticket'));
  }
  for (const email of [undefined, null, '', 'missing-at', 'é@example.test', 'a'.repeat(255) + '@example.test']) {
    await rejectsAsInvalid(service(payload({ email })).verify('ticket'));
  }
  assert.equal((await service(payload({ email: ' First.Last+Class@GMAIL.COM ' })).verify('ticket')).email, 'first.last+class@gmail.com');
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
