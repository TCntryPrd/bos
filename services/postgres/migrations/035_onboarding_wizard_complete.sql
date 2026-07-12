-- Add the post-login assistant setup flag used by /api/auth/me and /api/auth/complete-wizard.
-- Existing users default to complete so deployments do not unexpectedly reopen first-login setup.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_wizard_complete boolean NOT NULL DEFAULT true;
