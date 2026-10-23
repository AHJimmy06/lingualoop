const test = require('node:test');
const assert = require('node:assert/strict');
const { externalProviderAvailability } = require('../dist/auth/external-auth.providers.js');

const key = 'k'.repeat(32);
const google = {
  GOOGLE_CLIENT_ID: 'google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback',
  LINGUALOOP_WEB_ORIGIN: 'http://localhost:5001',
  LINGUALOOP_TOKEN_SIGNING_KEY: key,
};
const microsoft = {
  MICROSOFT_CLIENT_ID: 'microsoft-client-id',
  MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
  MICROSOFT_CALLBACK_URL: 'http://localhost:5000/auth/microsoft/callback',
};

test('providers remain hidden until credentials, callbacks and session signing key are configured', () => {
  assert.deepEqual(externalProviderAvailability({}), { google: false, microsoft: false });
  assert.deepEqual(externalProviderAvailability(google), { google: true, microsoft: false });
  assert.deepEqual(externalProviderAvailability({ ...google, ...microsoft }), { google: true, microsoft: true });
});

test('Microsoft provider rejects an insecure non-loopback callback and mismatched host', () => {
  assert.deepEqual(externalProviderAvailability({ ...microsoft, LINGUALOOP_WEB_ORIGIN: 'http://10.0.0.5',
    MICROSOFT_CALLBACK_URL: 'http://10.0.0.5:5000/auth/microsoft/callback', LINGUALOOP_TOKEN_SIGNING_KEY: key }),
  { google: false, microsoft: false });
  assert.deepEqual(externalProviderAvailability({ ...microsoft, LINGUALOOP_WEB_ORIGIN: 'http://localhost:5001',
    MICROSOFT_CALLBACK_URL: 'http://127.0.0.1:5000/auth/microsoft/callback', LINGUALOOP_TOKEN_SIGNING_KEY: key }),
  { google: false, microsoft: false });
});

test('Google client ID alone determines availability and must be nonempty printable ASCII', () => {
  assert.deepEqual(externalProviderAvailability(google), { google: true, microsoft: false });
  for (const clientId of [undefined, '', '   ', 'invalid client id']) {
    assert.equal(externalProviderAvailability({ ...google, GOOGLE_CLIENT_ID: clientId }).google, false);
  }
});
