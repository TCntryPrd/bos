-- 018_rascals_coo_remove.sql — undo the COO seed from 017.
--
-- v1.5.3 / migration 017 seeded a row into boss_rascals with handle='coo'
-- pointing at /home/tcntryprd/.claude. That was a category mistake: the COO
-- in the v2 design IS IR Custom AIOS (the operator running this Claude Code tree).
-- It is not a Rascal — Rascals are autonomous per-target agents that IR Custom AIOS
-- supervises. Conflating the two pollutes the Rascals registry, the cards
-- grid, and any "for each rascal" loops (cron, pipeline assignment).
--
-- The /coo surface still works — it talks straight to the brain CLI session
-- and never reads boss_rascals.
--
-- Idempotent.

DELETE FROM boss_rascals WHERE handle = 'coo';
