const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { LanguagePracticeSessionStore } = require('../../dist/language-practice/language-practice-session-store.js');
const { LanguagePracticeSessionController } = require('../../dist/language-practice/language-practice-session.controller.js');
const { validatePracticeInput, PracticeCatalogueStore } = require('../../dist/language-practice/practice-catalogue.js');
const owner = '123e4567-e89b-42d3-a456-426614174000';
const id = '223e4567-e89b-42d3-a456-426614174000';
const setup = { level: 'A1', topic: 'travel', durationMinutes: 5 };
const authoring = { title: 'Coffee', setup: { level: 'A1', durationMinutes: 5 }, parameters: [{ requirement: 'Order coffee' }] };
const row = { id, status: 'ACTIVE', ...setup, difficulty: null, startedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:05:00Z', remainingMs: 300000 };
const catalogueRow = { id, teacher_id: owner, teacher_name: 'Teacher', title: 'Coffee', topic: 'travel', level: 'A1', duration_minutes: 5, difficulty: null, parameters: [{ id, requirement: 'Order coffee' }], created_at: '2026-01-01' };
const request = { verifiedIdentity: { ownerId: owner } };

test('new default sessions normalize omitted difficulty and persist every independent choice', async () => {
  for (const difficulty of [undefined, 'easy', 'medium', 'hard']) {
    const expected = difficulty ?? 'medium';
    let calls = 0;
    const store = new LanguagePracticeSessionStore({ async query(sql, values) {
      calls++;
      assert.match(sql, /duration_minutes, difficulty, started_at/);
      assert.match(sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, NOW\(\)/);
      assert.match(sql, /RETURNING id, status, level, topic, difficulty/);
      assert.deepEqual(values, [owner, 'A1', 'travel', 5, expected]);
      return { rows: [{ ...row, difficulty: expected }] };
    } });
    const input = difficulty === undefined ? setup : { ...setup, difficulty };
    const dto = await store.createSession(owner, input);
    assert.equal(dto.difficulty, expected);
    assert.equal(dto.level, 'A1');
    assert.equal(dto.durationMinutes, 5);
    assert.equal(calls, 1);
  }
});

test('default controller normalizes omission before calling store and rejects invalid or extra fields', async () => {
  let calls = 0;
  const controller = new LanguagePracticeSessionController({ async createSession(boundOwner, input) {
    calls++;
    assert.equal(boundOwner, owner);
    assert.equal(input.difficulty, 'medium');
    return { ...row, difficulty: input.difficulty };
  } }, {}, {});
  assert.equal((await controller.createSession(setup, request)).difficulty, 'medium');
  for (const difficulty of [null, undefined, '', 'HARD', 'B1', 1, false, [], {}]) {
    await assert.rejects(controller.createSession({ ...setup, difficulty }, request), { status: 400 });
  }
  await assert.rejects(controller.createSession({ ...setup, unrelated: true }, request), { status: 400 });
  assert.equal(calls, 1);
});

test('every CEFR level accepts every difficulty independently in both creation inputs', async () => {
  const controller = new LanguagePracticeSessionController({ async createSession(boundOwner, input) {
    assert.equal(boundOwner, owner);
    return { ...row, ...input };
  } }, {}, {});
  for (const level of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      const created = await controller.createSession({ ...setup, level, difficulty }, request);
      assert.deepEqual([created.level, created.topic, created.durationMinutes, created.difficulty], [level, 'travel', 5, difficulty]);
      const teacher = validatePracticeInput({ ...authoring, setup: { ...authoring.setup, level, difficulty } });
      assert.deepEqual(teacher.setup, { level, durationMinutes: 5, difficulty });
    }
  }
});

test('store and teacher authoring reject invalid difficulty and unrelated keys before SQL', async () => {
  let calls = 0;
  const store = new LanguagePracticeSessionStore({ async query() { calls++; return { rows: [row] }; } });
  for (const difficulty of [null, undefined, '', 'HARD', 'B1', 1, false, [], {}]) {
    await assert.rejects(store.createSession(owner, { ...setup, difficulty }));
    assert.throws(() => validatePracticeInput({ ...authoring, setup: { ...authoring.setup, difficulty } }));
  }
  await assert.rejects(store.createSession(owner, { ...setup, unrelated: true }));
  assert.throws(() => validatePracticeInput({ ...authoring, setup: { ...authoring.setup, unrelated: true } }));
  assert.equal(calls, 0);
});

test('teacher creation normalizes omission and persists difficulty without changing level or duration', async () => {
  for (const difficulty of [undefined, 'easy', 'medium', 'hard']) {
    const expected = difficulty ?? 'medium';
    const body = difficulty === undefined ? authoring : { ...authoring, setup: { ...authoring.setup, difficulty } };
    assert.equal(validatePracticeInput(body).setup.difficulty, expected);
    const store = new PracticeCatalogueStore({ async query(sql, values) {
      assert.match(sql, /duration_minutes, parameters, difficulty/);
      assert.match(sql, /\$6::jsonb, \$8/);
      assert.deepEqual(values.slice(0, 5), [owner, 'Coffee', 'everyday-conversation', 'A1', 5]);
      assert.equal(values[7], expected);
      return { rows: [{ ...catalogueRow, difficulty: values[7] }] };
    } });
    assert.equal((await store.create(owner, body)).setup.difficulty, expected);
  }
});

test('catalogue detail/list and owned session reads expose nullable historical difficulty without defaulting', async () => {
  for (const difficulty of [null, 'easy', 'medium', 'hard']) {
    const catalogue = new PracticeCatalogueStore({ async query() { return { rows: [{ ...catalogueRow, difficulty }] }; } });
    assert.equal((await catalogue.list(owner, 'student'))[0].setup.difficulty, difficulty);
    assert.equal((await catalogue.detail(owner, 'teacher', id)).setup.difficulty, difficulty);
    const store = new LanguagePracticeSessionStore({ async query(sql, values) {
      assert.match(sql, /\bdifficulty\b/);
      assert.deepEqual(values, [owner, id]);
      assert.match(sql, /owner_id = \$1(?:::uuid)? AND id = \$2/);
      assert.doesNotMatch(sql, /FROM lingualoop_practices/);
      return { rows: [{ ...row, difficulty, parameters_snapshot: [], conversation_theme_snapshot: null }] };
    } });
    assert.equal((await store.getSession(owner, id)).difficulty, difficulty);
    assert.equal((await store.getOwnedSnapshot(owner, id)).difficulty, difficulty);
  }
});

test('invalid persisted difficulty fails closed rather than inventing historical medium', async () => {
  for (const difficulty of [undefined, 'unknown', 2, {}, false]) {
    const store = new LanguagePracticeSessionStore({ async query() { return { rows: [{ ...row, difficulty, parameters_snapshot: [], conversation_theme_snapshot: null }] }; } });
    await assert.rejects(store.getSession(owner, id));
    await assert.rejects(store.getOwnedSnapshot(owner, id));
    const catalogue = new PracticeCatalogueStore({ async query() { return { rows: [{ ...catalogueRow, difficulty }] }; } });
    await assert.rejects(catalogue.list(owner, 'student'));
  }
});

test('custom session is one authoritative INSERT SELECT copying even NULL difficulty', async () => {
  for (const difficulty of [null, 'easy', 'medium', 'hard']) {
    let calls = 0;
    const store = new LanguagePracticeSessionStore({ async query(sql, values) {
      calls++;
      assert.deepEqual(values, [owner, id]);
      assert.match(sql, /INSERT INTO lingualoop_language_practice_sessions/);
      assert.match(sql, /conversation_theme_snapshot, difficulty, activity_snapshot\)/);
      assert.match(sql, /id, parameters, conversation_theme, difficulty, activity\s+FROM lingualoop_practices WHERE id = \$2::uuid/);
      assert.doesNotMatch(sql, /COALESCE|UPDATE/);
      return { rows: [{ ...row, difficulty }] };
    } });
    assert.equal((await store.createCustomSession(owner, id)).difficulty, difficulty);
    assert.equal(calls, 1);
  }
  assert.equal(await new LanguagePracticeSessionStore({ async query() { return { rows: [] }; } }).createCustomSession(owner, id), null);
});

test('custom request accepts only practiceId, never learner difficulty or setup overrides', async () => {
  let calls = 0;
  const controller = new LanguagePracticeSessionController({ async createCustomSession(boundOwner, practiceId) {
    calls++;
    assert.deepEqual([boundOwner, practiceId], [owner, id]);
    return row;
  } }, {}, {});
  assert.equal((await controller.createSession({ practiceId: id }, request)).difficulty, null);
  for (const extra of [{ difficulty: 'hard' }, { difficulty: null }, { ...setup }, { parameters: [] }, { ownerId: owner }]) {
    await assert.rejects(controller.createSession({ practiceId: id, ...extra }, request), { status: 400 });
  }
  assert.equal(calls, 1);
});
