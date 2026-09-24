const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Controller,
  Get,
  Module,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { HealthController } = require('../../dist/health.controller.js');

function fakeExecutor(error) {
  const calls = [];
  return {
    calls,
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (error) throw error;
      return { rows: [{ '?column?': 1 }] };
    },
  };
}

test('Nest defaults preserve standard 4xx statuses and hide unknown exception details offline', async (t) => {
  class ExceptionController {
    notFound() { throw new NotFoundException('missing route'); }
    unauthorized() { throw new UnauthorizedException('login required'); }
    unknown() { throw new Error('raw database detail must not leak'); }
  }
  Controller()(ExceptionController);
  for (const [route, method] of [['not-found', 'notFound'], ['unauthorized', 'unauthorized'], ['unknown', 'unknown']]) {
    Get(route)(ExceptionController.prototype, method, Object.getOwnPropertyDescriptor(ExceptionController.prototype, method));
  }
  class OfflineExceptionModule {}
  Module({ controllers: [ExceptionController] })(OfflineExceptionModule);

  const app = await NestFactory.create(OfflineExceptionModule, { logger: false });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const notFound = await fetch(`${baseUrl}/not-found`);
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).message, 'missing route');

  const unauthorized = await fetch(`${baseUrl}/unauthorized`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).message, 'login required');

  const unknown = await fetch(`${baseUrl}/unknown`);
  assert.equal(unknown.status, 500);
  const unknownBody = await unknown.text();
  assert.equal(unknownBody.includes('raw database detail'), false);
});

test('health stays a liveness check and readiness probes the database with SELECT 1', async () => {
  const database = fakeExecutor();
  const controller = new HealthController(database);

  assert.deepEqual(controller.getHealth(), { status: 'ok' });
  assert.deepEqual(database.calls, [], '/health does not depend on PostgreSQL');
  assert.deepEqual(await controller.getReadiness(), { status: 'ok' });
  assert.deepEqual(database.calls, [{ sql: 'SELECT 1', parameters: [] }]);
});

test('readiness fails closed with a generic service error and does not expose database details', async () => {
  const database = fakeExecutor(new Error('connection failed: password must not leak'));
  const controller = new HealthController(database);

  await assert.rejects(controller.getReadiness(), (error) => {
    assert.ok(error instanceof ServiceUnavailableException);
    assert.equal(error.message, 'Database unavailable');
    assert.equal(error.message.includes('password'), false);
    return true;
  });
  assert.deepEqual(database.calls, [{ sql: 'SELECT 1', parameters: [] }]);
});
