-- OAuth owns credentials; never store provider passwords or tokens in account profiles.
ALTER TABLE lingualoop_accounts DROP COLUMN password_hash;
