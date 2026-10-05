-- PostgreSQL names the column-level 008 CHECK as <table>_<column>_check.
-- Drop only that exact constraint; leave the report primary key and other checks intact.
ALTER TABLE lingualoop_language_practice_reports
  DROP CONSTRAINT IF EXISTS lingualoop_language_practice_reports_generated_with_ai_check;
