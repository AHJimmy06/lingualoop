const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleAuthFlow, GoogleAuthFlowError } = require('../../dist/auth/google-auth-flow.js');

const callbackUrl = 'https://login.example.test/auth/google/callback';
const webOrigin = 'https://login.example.test';
const clientId = 'lingualoop-client-id.apps.googleusercontent.com';
const state = 'A'.repeat(43);

function makeFlow(overrides = {}) {
  const calls = [];
  const flow = new GoogleAuthFlow({
    callbackUrl,
    webOrigin,
    clientId,
    stateService: {
      async createState(options) { calls.push(['createState', options]); return state; },
      async consumeState(value, provider) { calls.push(['consumeState', value, provider]); },
    },
    codeExchange: { async exchange(code) { calls.push(['exchange', code]); return { idToken: 'untrusted-id-token' }; } },
    loginSession: { async issue(token) { calls.push(['issue', token]); return {
      accessToken: 'must-not-escape', refreshCredential: 'refresh-secret', expiresAtMs: 1_700_604_800_000,
    }; } },
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  return { flow, calls };
}

const cookieHeader = `__Host-lingualoop-oauth-state=${state}`;

test('begin creates one Google state and returns only the exact configured authorization request and state cookie', async () => {
  const { flow, calls } = makeFlow();
  const result = await flow.begin();
  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual([...url.searchParams.entries()], [
    ['response_type', 'code'], ['client_id', clientId], ['redirect_uri', callbackUrl],
    ['scope', 'openid email'], ['state', state],
  ]);
  assert.match(result.stateCookie, new RegExp(`^__Host-lingualoop-oauth-state=${state};`));
  assert.deepEqual(calls, [['createState', { provider: 'google' }]]);
  assert.equal(JSON.stringify(result).includes('refresh'), false);
});

test('finish consumes browser-bound Google state before exchange and session issuance', async () => {
  const { flow, calls } = makeFlow();
  const result = await flow.finish({ cookieHeader, state, code: 'authorization-code' });
  assert.deepEqual(calls, [
    ['consumeState', state, 'google'], ['exchange', 'authorization-code'], ['issue', 'untrusted-id-token'],
  ]);
  assert.equal(result.redirectUrl, webOrigin);
  assert.match(result.refreshCookie, /^__Host-lingualoop-refresh=refresh-secret;/);
  assert.match(result.refreshCookie, /Max-Age=604800$/);
  assert.match(result.stateCookie, /Max-Age=0$/);
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape|untrusted-id-token|authorization-code|[?&]state=/);
});

test('absent, duplicate, and mismatched browser state fail before exchange; state can always be cleared', async () => {
  const { flow, calls } = makeFlow();
  for (const header of [undefined, `${cookieHeader}; ${cookieHeader}`, `__Host-lingualoop-oauth-state=${'B'.repeat(43)}`]) {
    await assert.rejects(flow.finish({ cookieHeader: header, state, code: 'code' }), GoogleAuthFlowError);
  }
  assert.deepEqual(calls, []);
  assert.match(flow.clearStateCookie(), /Max-Age=0$/);
});

test('provider errors and absent code consume valid state but never exchange or issue', async () => {
  for (const callback of [{ error: 'access_denied' }, { code: '' }]) {
    const { flow, calls } = makeFlow();
    await assert.rejects(flow.finish({ cookieHeader, state, ...callback }), (error) => {
      assert.equal(error.message, 'Google login could not be completed.');
      return error instanceof GoogleAuthFlowError;
    });
    assert.deepEqual(calls, [['consumeState', state, 'google']]);
  }
});

test('exchange or session issuance failures remain generic after one-time state consumption', async () => {
  for (const overrides of [
    { codeExchange: { async exchange() { throw new Error('sensitive provider response'); } } },
    { loginSession: { async issue() { throw new Error('sensitive issuance detail'); } } },
  ]) {
    const { flow, calls } = makeFlow(overrides);
    await assert.rejects(flow.finish({ cookieHeader, state, code: 'code' }), (error) => {
      assert.equal(error.message, 'Google login could not be completed.');
      assert.doesNotMatch(error.message, /sensitive|code/);
      return error instanceof GoogleAuthFlowError;
    });
    assert.equal(calls[0][0], 'consumeState');
    assert.equal(calls.some((call) => call[0] === 'exchange'), overrides.loginSession !== undefined);
  }
});

test('consumed state cannot be replayed, and configuration is mandatory', async () => {
  let consumed = false;
  const { flow } = makeFlow({ stateService: {
    async createState() { return state; },
    async consumeState() { if (consumed) throw new Error('already consumed'); consumed = true; },
  } });
  await flow.finish({ cookieHeader, state, code: 'first' });
  await assert.rejects(flow.finish({ cookieHeader, state, code: 'second' }), GoogleAuthFlowError);
  assert.throws(() => new GoogleAuthFlow({}), TypeError);
});

test('client ID configuration is bounded printable ASCII and rejected without exposing its value', () => {
  for (const invalidClientId of [
    '', 'client id', 'client\tid', 'client\n', 'client\u0000id', 'clienté', 'x'.repeat(256),
  ]) {
    assert.throws(() => makeFlow({ clientId: invalidClientId }), (error) => {
      assert.equal(error.message, 'GOOGLE_CLIENT_ID must be explicitly configured.');
      assert.doesNotMatch(error.message, /client|x{20}/);
      return error instanceof TypeError;
    });
  }
  assert.doesNotThrow(() => makeFlow({ clientId: 'x'.repeat(255) }));
});
