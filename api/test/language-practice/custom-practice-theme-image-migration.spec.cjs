const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('unapplied 012 preserves nullable themes and adds bounded JPEG storage without backfill', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/012_custom_practice_theme_image.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE lingualoop_practices\s+ADD COLUMN conversation_theme VARCHAR\(120\)/i);
  assert.match(sql, /ALTER TABLE lingualoop_language_practice_sessions\s+ADD COLUMN conversation_theme_snapshot VARCHAR\(120\)/i);
  for (const column of ['conversation_theme', 'conversation_theme_snapshot']) {
    assert.match(sql, new RegExp(`${column} IS NULL OR char_length\\(btrim\\(${column}\\)\\) BETWEEN 1 AND 120`, 'i'));
  }
  assert.doesNotMatch(sql, /(?:^|;)\s*(?:UPDATE|INSERT|DELETE|DROP)\b|\bDEFAULT\b/im);
  assert.match(sql, /CREATE TABLE lingualoop_practice_images/i);
  assert.match(sql, /practice_id UUID PRIMARY KEY REFERENCES lingualoop_practices\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /bytes BYTEA NOT NULL/i);
  assert.match(sql, /mime TEXT NOT NULL CHECK \(mime = 'image\/jpeg'\)/i);
  assert.match(sql, /octet_length\(bytes\) BETWEEN 1 AND 2097152/i);
  assert.equal(sql.replace(/--[^\n]*/g, '').split(';').filter(statement => statement.trim()).length, 3);
});
