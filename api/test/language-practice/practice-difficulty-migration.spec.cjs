const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('013 adds only nullable constrained difficulty columns with no default or history rewrite', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/013_practice_difficulty.sql'), 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
  assert.equal(statements.length, 2);
  for (const [index, table] of ['lingualoop_practices', 'lingualoop_language_practice_sessions'].entries()) {
    assert.match(statements[index], new RegExp(`^ALTER TABLE ${table}\\s+ADD COLUMN difficulty VARCHAR\\(6\\)\\s+CHECK \\(difficulty IN \\('easy', 'medium', 'hard'\\)\\)$`, 'i'));
  }
  assert.doesNotMatch(sql, /\bDEFAULT\b|NOT NULL|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bINSERT\b|\bDROP\b/i);
});
