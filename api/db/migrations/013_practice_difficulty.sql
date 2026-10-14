-- Difficulty is a task condition independent of CEFR; NULL preserves unknown history.
ALTER TABLE lingualoop_practices
  ADD COLUMN difficulty VARCHAR(6)
    CHECK (difficulty IN ('easy', 'medium', 'hard'));

ALTER TABLE lingualoop_language_practice_sessions
  ADD COLUMN difficulty VARCHAR(6)
    CHECK (difficulty IN ('easy', 'medium', 'hard'));
