const test = require('node:test');
const assert = require('node:assert/strict');
const { MicrosoftAuthFlow } = require('../dist/auth/microsoft-auth-flow.js');

const state = 'A'.repeat(43);
const callbackUrl = 'http://localhost:5000/auth/microsoft/callback';
const webOrigin = 'http://localhost:5001';

test('Microsoft common authorization flow issues state and nonce and uses the existing refresh-cookie session', async () => {
  const consumed = [];
  const calls = [];
  const flow = new MicrosoftAuthFlow({
    callbackUrl, webOrigin, clientId: 'client-id',
    stateService: {
      async createState({ provider }) { assert.equal(provider, 'microsoft'); return state; },
      async consumeState(value, provider) { consumed.push([value, provider]); },
    },
    codeExchange: { async exchange(code) { assert.equal(code, 'auth-code'); return { idToken: 'signed-id-token', accessToken: 'graph-access-token' }; } },
    loginSession: { async issue(token, nonce, accessToken) {
      calls.push([token, nonce, accessToken]);
      return { accessToken: 'never-used-in-url', refreshCredential: 'opaque-refresh', expiresAtMs: Date.now() + 60_000 };
    } },
  });
  const started = await flow.begin();
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, 'https://login.microsoftonline.com');
  assert.equal(authorization.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('redirect_uri'), callbackUrl);
  assert.equal(authorization.searchParams.get('state'), state);
  assert.match(authorization.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/);
  const nonce = started.nonceCookie.match(/=(.*?);/)[1];
  const cookieHeader = `${started.stateCookie.split(';')[0]}; lingualoop-microsoft-nonce=${nonce}`;
  const finished = await flow.finish({ cookieHeader, state, code: 'auth-code' });
  assert.equal(finished.redirectUrl, webOrigin);
  assert.match(finished.refreshCookie, /^lingualoop-refresh=opaque-refresh;/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'signed-id-token');
  assert.equal(calls[0][1], nonce);
  assert.equal(calls[0][2], 'graph-access-token');
  assert.deepEqual(consumed, [[state, 'microsoft']]);
});

test('Microsoft callback rejects state without a matching browser cookie before token exchange', async () => {
  let exchanges = 0;
  const flow = new MicrosoftAuthFlow({
    callbackUrl, webOrigin, clientId: 'client-id',
    stateService: { async createState() { return state; }, async consumeState() { throw new Error('wrong provider'); } },
    codeExchange: { async exchange() { exchanges++; throw new Error(); } },
    loginSession: { async issue() { throw new Error(); } },
  });
  await assert.rejects(flow.finish({ cookieHeader: `lingualoop-microsoft-oauth-state=${state}; lingualoop-microsoft-nonce=${'N'.repeat(43)}`, state, code: 'auth-code' }));
  assert.equal(exchanges, 0);
});
