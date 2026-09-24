const test = require('node:test');
const assert = require('node:assert/strict');
const { GOOGLE_CALLBACK_PATH, loadGoogleOAuthConfig } = require('../../dist/auth/google-oauth.config.js');

const VALID_CALLBACK = `https://login.example.test${GOOGLE_CALLBACK_PATH}`;
const VALID_ORIGIN = 'https://app.example.test';

function config(overrides = {}) {
  return loadGoogleOAuthConfig({
    GOOGLE_CALLBACK_URL: VALID_CALLBACK,
    LINGUALOOP_WEB_ORIGIN: VALID_ORIGIN,
    ...overrides,
  });
}

test('accepts explicit canonical HTTPS callback and one web origin', () => {
  assert.deepEqual(config(), {
    callbackUrl: VALID_CALLBACK,
    webOrigin: VALID_ORIGIN,
  });
});

test('accepts HTTP only for explicit loopback development URLs', () => {
  assert.deepEqual(config({
    GOOGLE_CALLBACK_URL: `http://localhost:5000${GOOGLE_CALLBACK_PATH}`,
    LINGUALOOP_WEB_ORIGIN: 'http://127.0.0.1:5001',
  }), {
    callbackUrl: `http://localhost:5000${GOOGLE_CALLBACK_PATH}`,
    webOrigin: 'http://127.0.0.1:5001',
  });
  assert.equal(config({
    GOOGLE_CALLBACK_URL: `http://[::1]:5000${GOOGLE_CALLBACK_PATH}`,
    LINGUALOOP_WEB_ORIGIN: 'http://localhost:5001',
  }).webOrigin, 'http://localhost:5001');
});

test('requires both explicit settings and does not synthesize deployment URLs', () => {
  for (const env of [
    {},
    { GOOGLE_CALLBACK_URL: VALID_CALLBACK },
    { LINGUALOOP_WEB_ORIGIN: VALID_ORIGIN },
    { GOOGLE_CALLBACK_URL: '', LINGUALOOP_WEB_ORIGIN: VALID_ORIGIN },
  ]) {
    assert.throws(() => loadGoogleOAuthConfig(env), TypeError);
  }
});

test('rejects non-HTTPS public callback URLs and origins', () => {
  assert.throws(() => config({ GOOGLE_CALLBACK_URL: `http://login.example.test${GOOGLE_CALLBACK_PATH}` }), /HTTPS/);
  assert.throws(() => config({ LINGUALOOP_WEB_ORIGIN: 'http://app.example.test' }), /HTTPS/);
  assert.throws(() => config({ GOOGLE_CALLBACK_URL: `ftp://localhost${GOOGLE_CALLBACK_PATH}` }), /canonical/);
});

test('rejects callback credentials, query, fragment, wrong path, and encoded path ambiguity', () => {
  for (const url of [
    `https://user:pass@login.example.test${GOOGLE_CALLBACK_PATH}`,
    `${VALID_CALLBACK}?next=/`,
    `${VALID_CALLBACK}#fragment`,
    'https://login.example.test/auth/google/callback/',
    'https://login.example.test/auth/google/%63allback',
    'https://login.example.test/auth/google/../auth/google/callback',
    'https://login.example.test\\auth\\google\\callback',
  ]) {
    assert.throws(() => config({ GOOGLE_CALLBACK_URL: url }), TypeError, url);
  }
});

test('rejects web-origin credentials, paths, queries, fragments, and normalization', () => {
  for (const origin of [
    'https://user:pass@app.example.test',
    'https://app.example.test/path',
    'https://app.example.test/',
    'https://app.example.test?next=/',
    'https://app.example.test#fragment',
    'https://APP.example.test',
    'https://app.example.test:443',
  ]) {
    assert.throws(() => config({ LINGUALOOP_WEB_ORIGIN: origin }), TypeError, origin);
  }
});
