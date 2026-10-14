const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const sharp = require('sharp');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfiguredVerifiedRequestGuard } = require('../../dist/auth/google-auth.providers.js');
const { LinguaLoopTokenService } = require('../../dist/auth/lingualoop-token.service.js');
const { InvalidBearerTokenError } = require('../../dist/auth/verified-request.guard.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../../dist/auth/auth-store.providers.js');
const { GOOGLE_BROWSER_POLICY } = require('../../dist/auth/google-browser-policy.js');
const { RoleGuard } = require('../../dist/auth/role.guard.js');
const { PracticeCatalogueController } = require('../../dist/language-practice/practice-catalogue.controller.js');
const { PracticeCatalogueStore, PRACTICE_CATALOGUE_STORE } = require('../../dist/language-practice/practice-catalogue.js');
const { LANGUAGE_PRACTICE_REPORT_STORE } = require('../../dist/language-practice/language-practice-session.providers.js');
const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '223e4567-e89b-42d3-a456-426614174000';
const P = '323e4567-e89b-42d3-a456-426614174000';
const S = '423e4567-e89b-42d3-a456-426614174000';
const origin = 'http://localhost:4400';
const input = { title: 'Coffee in Madrid', setup: { level: 'B1', durationMinutes: 5 }, parameters: [{ requirement: 'Order' }] };

async function server(t) {
  let role = 'teacher', owner = A, failure = false;
  const calls = [], rows = new Map(), images = new Map();
  const store = new PracticeCatalogueStore({ async query(sql, values) {
    calls.push({ sql, values });
    if (failure) throw new Error('PRIVATE provider data');
    if (sql.includes('INSERT INTO lingualoop_practices')) {
      const row = { id: P, teacher_id: values[0], teacher_name: 'Teacher', title: values[1], conversation_theme: values[1], topic: values[2], level: values[3], duration_minutes: values[4], parameters: JSON.parse(values[5]), created_at: '2026-01-01', has_image: !!values[6] };
      rows.set(P, row); if (values[6]) images.set(P, { bytes: values[6], mime: 'image/jpeg' });
      return { rows: [row] };
    }
    if (sql.includes('SELECT i.bytes')) {
      const row = rows.get(values[0]);
      return { rows: row && (!values[1] || row.teacher_id === values[1]) && images.has(values[0]) ? [images.get(values[0])] : [] };
    }
    return { rows: [...rows.values()].filter(row => !sql.includes('WHERE p.id') || row.id === values[0]) };
  } });
  class OfflineModule {}
  Module({ controllers: [PracticeCatalogueController], providers: [
    ConfiguredVerifiedRequestGuard, RoleGuard,
    { provide: GOOGLE_BROWSER_POLICY, useValue: { isAllowedRefreshOrLogoutOrigin: value => value === origin } },
    { provide: LinguaLoopTokenService, useValue: { async verifyBearerToken(token) { if (token !== 'valid') throw new InvalidBearerTokenError(); return { issuer: 'local', subject: A, sessionId: S }; } } },
    { provide: LINGUALOOP_IDENTITY_STORE, useValue: { async findOwnerByIdentity() { return owner; }, async findAccountByOwner() { return { name: 'Account', email: 'test@example.test', role }; } } },
    { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive() { return true; } } },
    { provide: PRACTICE_CATALOGUE_STORE, useValue: store },
    { provide: LANGUAGE_PRACTICE_REPORT_STORE, useValue: {} },
  ] })(OfflineModule);
  const app = await NestFactory.create(OfflineModule, { logger: false });
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/language-practice/practices`;
  return { calls, images, rows, setRole(value) { role = value; }, setOwner(value) { owner = value; }, fail() { failure = true; },
    async post(body, headers = {}) { return fetch(base, { method: 'POST', headers: { authorization: 'Bearer valid', origin, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...headers }, body: body instanceof FormData ? body : JSON.stringify(body) }); },
    async get(id = P, headers = {}) { return fetch(`${base}/${id}/image`, { headers: { authorization: 'Bearer valid', ...headers } }); },
    async list() { return fetch(base, { headers: { authorization: 'Bearer valid' } }); },
  };
}
const png = () => sharp({ create: { width: 9, height: 7, channels: 4, background: '#ff000088' } }).png().toBuffer();
function form(bytes, mime = 'image/png', metadata = JSON.stringify(input)) {
  const body = new FormData(); body.append('metadata', metadata);
  if (bytes) body.append('image', new Blob([bytes], { type: mime }), '../../not-a-path.png');
  return body;
}

test('strict JSON and optional multipart image create normalized covers with boolean-only DTO', async t => {
  const api = await server(t);
  let response = await api.post(input); assert.equal(response.status, 201);
  assert.equal((await response.json()).hasImage, false);
  assert.equal(api.calls.at(-1).values[6], null);
  assert.equal((await api.get()).status, 404);
  response = await api.post(form()); assert.equal(response.status, 201);
  assert.equal((await response.json()).hasImage, false);
  response = await api.post(form(await png())); assert.equal(response.status, 201);
  const dto = await response.json(); assert.equal(dto.hasImage, true);
  assert.equal(Object.hasOwn(dto, 'bytes'), false);
  assert.equal((await sharp(api.images.get(P).bytes).metadata()).format, 'jpeg');
  assert.equal((await (await api.list()).json()).practices[0].hasImage, true);
});

test('invalid metadata/images and multipart multiplicity never insert; strict JSON cannot attach image', async t => {
  const api = await server(t);
  const bytes = await png();
  const extra = form(bytes); extra.append('other', 'x');
  const duplicate = form(bytes); duplicate.append('image', new Blob([bytes], { type: 'image/png' }), 'second.png');
  const repeated = form(bytes); repeated.append('metadata', JSON.stringify(input));
  for (const body of [form(bytes, 'image/jpeg'), form(Buffer.from('<svg/>')), form(bytes.subarray(0, bytes.length - 10)), form(bytes, 'image/png', '{bad'), form(bytes, 'image/png', JSON.stringify({ ...input, setup: { ...input.setup, topic: 'travel' } })), form(Buffer.alloc(2 * 1024 * 1024 + 1)), extra, duplicate, repeated, { ...input, image: 'base64' }, { ...input, setup: { ...input.setup, topic: 'travel' } }]) {
    const response = await api.post(body); assert.ok([400, 413].includes(response.status), await response.text());
  }
  assert.equal(api.calls.length, 0);
  assert.equal(api.rows.size, 0);
});

test('auth/teacher/Origin gates reject creation without any SQL or media work', async t => {
  const api = await server(t);
  assert.equal((await api.post(form(await png()), { authorization: '' })).status, 401);
  for (const role of ['student', 'admin']) { api.setRole(role); assert.equal((await api.post(form(await png()))).status, 403); }
  api.setRole('teacher');
  for (const value of ['', 'https://foreign.example', `${origin}/extra`]) assert.equal((await api.post(form(await png()), { origin: value })).status, 403);
  assert.equal(api.calls.length, 0);
});

test('authenticated image retrieval returns JPEG nosniff private no-store; foreign/missing share 404 and admin cannot probe', async t => {
  const api = await server(t);
  await api.post(form(await png()));
  for (const role of ['teacher', 'student']) {
    api.setRole(role); const response = await api.get(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), api.images.get(P).bytes);
  }
  api.setRole('teacher'); api.setOwner(B);
  const foreign = await api.get(); assert.equal(foreign.status, 404);
  const missing = await api.get(B); assert.equal(missing.status, 404);
  assert.equal(await foreign.text(), await missing.text());
  assert.equal((await api.get('invalid')).status, 404);
  api.setRole('student'); assert.equal((await api.get()).status, 200);
  const count = api.calls.length; api.setRole('admin');
  assert.equal((await api.get()).status, 403); assert.equal(api.calls.length, count);
  assert.equal((await api.get(P, { authorization: '' })).status, 401);
});

test('controller releases and zeroes memory upload buffers on success and invalid metadata', async () => {
  for (const valid of [true, false]) {
    const bytes = await png(); const file = { buffer: bytes, mimetype: 'image/png', originalname: '../../ignored.png' };
    const request = { headers: { 'content-type': 'multipart/form-data; boundary=test' }, file, verifiedIdentity: { ownerId: A, role: 'teacher' } };
    let inserts = 0;
    const controller = new PracticeCatalogueController({ async create(owner, metadata, image) {
      inserts++; assert.equal(owner, A); assert.deepEqual(metadata, input);
      assert.equal((await sharp(image.bytes).metadata()).format, 'jpeg');
      assert.equal(Object.hasOwn(image, 'originalname'), false);
      return { hasImage: true };
    } }, {});
    const call = controller.create({ metadata: JSON.stringify(valid ? input : { ...input, title: '' }) }, request, file);
    if (valid) assert.deepEqual(await call, { hasImage: true }); else await assert.rejects(call, { status: 400 });
    assert.equal(inserts, valid ? 1 : 0);
    assert.ok(bytes.every(byte => byte === 0)); assert.equal(request.file, undefined);
  }
});

test('DB failures are sanitized and failed creation does not return a successful DTO', async t => {
  const api = await server(t); api.fail();
  for (const response of [await api.post(form(await png())), await api.get()]) {
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|provider data/);
  }
  assert.equal(api.rows.size, 0);
});
