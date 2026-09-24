const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GoogleBrowserPolicyError,
  createGoogleBrowserPolicy,
} = require('../../dist/auth/google-browser-policy.js');

const callbackUrl = 'https://login.example.test/auth/google/callback';
const webOrigin = 'https://login.example.test';
function policy(overrides = {}) {
  return createGoogleBrowserPolicy({ callbackUrl, webOrigin, ...overrides });
}

test('requires validated explicit URLs on the same hostname and scheme', () => {
  assert.throws(() => createGoogleBrowserPolicy({ callbackUrl, webOrigin: undefined }), TypeError);
  assert.throws(() => policy({ callbackUrl: 'https://other.example.test/auth/google/callback' }), /same hostname/);
  assert.throws(() => createGoogleBrowserPolicy({ callbackUrl: 'http://localhost:5000/auth/google/callback', webOrigin: 'https://localhost:5001' }), /same scheme/);
  assert.throws(() => policy({ callbackUrl: 'http://public.example.test/auth/google/callback', webOrigin: 'http://public.example.test' }), TypeError);
  const localhost = createGoogleBrowserPolicy({
    callbackUrl: 'http://localhost:5000/auth/google/callback',
    webOrigin: 'http://localhost:5001',
  });
  assert.equal(localhost.isAllowedRefreshOrLogoutOrigin('http://localhost:5001'), true);
  assert.throws(() => createGoogleBrowserPolicy({
    callbackUrl: 'http://localhost:5000/auth/google/callback',
    webOrigin: 'http://127.0.0.1:5001',
  }), /same hostname/);
  assert.doesNotThrow(() => createGoogleBrowserPolicy({
    callbackUrl: 'http://127.0.0.1:5000/auth/google/callback',
    webOrigin: 'http://127.0.0.1:5001',
  }));
});

test('builds short state and absolute refresh cookies with host-only security attributes', () => {
  const p = policy();
  const stateCookie = p.stateCookie('A'.repeat(43));
  const refreshCookie = p.refreshCookie('refresh_token-123', 1_700_604_800_000, 1_700_000_000_000);
  for (const cookie of [stateCookie, refreshCookie]) {
    assert.match(cookie, /^__Host-lingualoop-/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.doesNotMatch(cookie, /; Domain=/i);
  }
  assert.match(stateCookie, /Max-Age=300/);
  assert.match(refreshCookie, /Max-Age=604800/);
  assert.match(p.clearStateCookie(), /^__Host-lingualoop-oauth-state=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0/);
  assert.match(p.clearRefreshCookie(), /Max-Age=0/);

  const dev = createGoogleBrowserPolicy({
    callbackUrl: 'http://localhost:5000/auth/google/callback', webOrigin: 'http://localhost:5001',
  });
  assert.match(dev.stateCookie('A'.repeat(43)), /^lingualoop-oauth-state=/);
  assert.doesNotMatch(dev.stateCookie('A'.repeat(43)), /; Secure/);
  assert.match(dev.refreshCookie('refresh_token-123', 1_700_604_800_000, 1_700_000_000_000), /Max-Age=604800/);
});

test('refresh cookie lifetime decreases from the original absolute expiration without sliding', () => {
  const p = policy();
  const expiresAtMs = 1_700_604_800_000;
  const first = p.refreshCookie('refresh_token-123', expiresAtMs, 1_700_000_000_000);
  const second = p.refreshCookie('rotated_token-456', expiresAtMs, 1_700_172_800_000);
  assert.match(first, /Max-Age=604800/);
  assert.match(second, /Max-Age=432000/);
  assert.match(p.refreshCookie('short_lived_token', expiresAtMs, expiresAtMs - 1_999), /Max-Age=1$/);
  assert.match(second, /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=432000$/);
});

test('rejects expired, invalid, out-of-range, and over-seven-day refresh expirations', () => {
  const p = policy();
  const nowMs = 1_700_000_000_000;
  for (const expiresAtMs of [
    nowMs,
    nowMs - 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER,
    8.64e15 + 1,
    nowMs + 7 * 24 * 60 * 60 * 1000 + 1,
  ]) {
    assert.throws(() => p.refreshCookie('refresh_token-123', expiresAtMs, nowMs), TypeError);
  }
  assert.throws(() => p.refreshCookie('refresh_token-123', nowMs + 1_000, Number.NaN), TypeError);
});

test('rejects absent, duplicate, malformed, and mismatched callback state generically', async () => {
  let consumed = 0;
  const p = policy({
    consumeState: async () => { consumed += 1; },
  });
  const state = 'A'.repeat(43);
  for (const header of [undefined, '', 'other=value', `__Host-lingualoop-oauth-state=${state}; __Host-lingualoop-oauth-state=${state}`, '__Host-lingualoop-oauth-state="bad"', '__Host-lingualoop-oauth-state=bad; broken']) {
    await assert.rejects(p.consumeCallbackState(header, state), (error) => {
      assert.equal(error.message, 'Google login could not be completed.');
      return error instanceof GoogleBrowserPolicyError;
    });
  }
  await assert.rejects(p.consumeCallbackState(`__Host-lingualoop-oauth-state=${state}`, `${state.slice(0, 42)}B`), GoogleBrowserPolicyError);
  assert.equal(consumed, 0);
});

test('matches state in constant time before invoking atomic consume exactly once', async () => {
  const state = 'A'.repeat(43);
  const seen = [];
  const p = policy({ consumeState: async (candidate) => seen.push(candidate) });
  assert.equal(await p.consumeCallbackState(`__Host-lingualoop-oauth-state=${state}`, state), undefined);
  assert.deepEqual(seen, [state]);
});

test('requires exact Origin equality including port; never accepts absent Origin or Host fallback', () => {
  const p = policy();
  assert.equal(p.isAllowedRefreshOrLogoutOrigin(webOrigin), true);
  assert.equal(p.isAllowedRefreshOrLogoutOrigin('https://login.example.test:443'), false);
  assert.equal(p.isAllowedRefreshOrLogoutOrigin('https://login.example.test:5001'), false);
  assert.equal(p.isAllowedRefreshOrLogoutOrigin(undefined), false);
  assert.equal(p.isAllowedRefreshOrLogoutOrigin('null'), false);
});

test('refresh cookie parsing requires one syntactically valid target cookie', () => {
  const p = policy();
  const credential = `${'a'.repeat(36)}.${'B'.repeat(43)}`;
  assert.equal(p.readRefreshCredential(`__Host-lingualoop-refresh=${credential}`), credential);
  for (const header of [undefined, '', 'other=value', '__Host-lingualoop-refresh="quoted"', '__Host-lingualoop-refresh=a; __Host-lingualoop-refresh=b', '__Host-lingualoop-refresh=a; malformed']) {
    assert.throws(() => p.readRefreshCredential(header), (error) => error.message === 'Google login could not be completed.');
  }
});
