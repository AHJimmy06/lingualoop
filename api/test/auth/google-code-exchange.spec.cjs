const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GoogleCodeExchange,
  GoogleCodeExchangeError,
} = require('../../dist/auth/google-code-exchange.js');

const CALLBACK_URL = 'https://login.example.test/auth/google/callback';
const ENV = {
  GOOGLE_CALLBACK_URL: CALLBACK_URL,
  LINGUALOOP_WEB_ORIGIN: 'https://app.example.test',
};

function exchangeWith(exchanger, env = ENV) {
  return new GoogleCodeExchange({ env, exchanger });
}

test('exchanges a bounded code with the exact validated configured callback URL', async () => {
  let received;
  const exchange = exchangeWith(async (code, redirectUri) => {
    received = { code, redirectUri };
    return { tokens: { id_token: 'untrusted-id-token' } };
  });

  assert.deepEqual(await exchange.exchange('authorization-code'), { idToken: 'untrusted-id-token' });
  assert.deepEqual(received, { code: 'authorization-code', redirectUri: CALLBACK_URL });
});

test('does not fall back to ambient credentials when an explicit environment omits them', () => {
  const previousClientId = process.env.GOOGLE_CLIENT_ID;
  const previousClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  try {
    process.env.GOOGLE_CLIENT_ID = 'ambient-fake-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'ambient-fake-client-secret';

    assert.throws(() => new GoogleCodeExchange({ env: ENV }), TypeError);
  } finally {
    if (previousClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousClientSecret;
  }
});

test('constructs the default OAuth client from explicit fake credentials without contacting Google', () => {
  const exchange = new GoogleCodeExchange({
    env: {
      ...ENV,
      GOOGLE_CLIENT_ID: 'explicit-fake-client-id',
      GOOGLE_CLIENT_SECRET: 'explicit-fake-client-secret',
    },
  });

  assert.ok(exchange instanceof GoogleCodeExchange);
});

test('rejects absent or malformed OAuth URL configuration before calling the exchanger', () => {
  let called = false;
  const exchanger = async () => {
    called = true;
    return { tokens: { id_token: 'token' } };
  };

  assert.throws(() => exchangeWith(exchanger, {
    ...ENV,
    GOOGLE_CALLBACK_URL: 'https://login.example.test/auth/google/other',
  }), TypeError);
  assert.throws(() => exchangeWith(exchanger, {
    ...ENV,
    GOOGLE_CALLBACK_URL: undefined,
  }), TypeError);
  assert.equal(called, false);
});

test('rejects empty, whitespace-bearing, and oversized authorization codes without exchange', async () => {
  let calls = 0;
  const exchange = exchangeWith(async () => {
    calls += 1;
    return { tokens: { id_token: 'token' } };
  });

  for (const code of ['', ' code', 'code ', 'code\nvalue', 'x'.repeat(2_049), null]) {
    await assert.rejects(exchange.exchange(code), GoogleCodeExchangeError);
  }
  assert.equal(calls, 0);
});

test('sanitizes exchanger failures without exposing provider details', async () => {
  const secretLikeFailure = 'provider rejected code=private-code secret=private-secret';
  const exchange = exchangeWith(async () => { throw new Error(secretLikeFailure); });

  await assert.rejects(exchange.exchange('private-code'), (error) => {
    assert.ok(error instanceof GoogleCodeExchangeError);
    assert.equal(error.message.includes('private-code'), false);
    assert.equal(error.message.includes('private-secret'), false);
    return true;
  });
});

test('fails closed on malformed, absent, and oversized returned ID tokens', async () => {
  for (const response of [
    null,
    {},
    { tokens: null },
    { tokens: {} },
    { tokens: { id_token: '' } },
    { tokens: { id_token: 42 } },
    { tokens: { id_token: 'x'.repeat(16_385) } },
  ]) {
    const exchange = exchangeWith(async () => response);
    await assert.rejects(exchange.exchange('authorization-code'), GoogleCodeExchangeError);
  }
});
