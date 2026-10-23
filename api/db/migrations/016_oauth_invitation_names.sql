-- Invitations reserve email/role only; OAuth supplies the display name upon first sign-in.
ALTER TABLE lingualoop_accounts ALTER COLUMN name DROP NOT NULL;
