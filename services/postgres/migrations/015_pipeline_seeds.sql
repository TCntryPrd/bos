-- Pipeline seed templates — 5 pre-built workflows for the Little Rascals.
-- See /home/tcntryprd/BOSS_V2_MASTER_PLAN.md §Phase 1.
--
-- Idempotent: inserts are guarded by a name+tenant lookup via INSERT ... SELECT
-- ... WHERE NOT EXISTS. Safe to re-run.

DO $$
DECLARE
  _tenant TEXT := 'default';
BEGIN

  -- 1. Client Meeting Followup
  INSERT INTO boss_pipelines (tenant_id, name, description, stages)
  SELECT _tenant,
         'Client Meeting Followup',
         'Auto-generated deliverable after a calendar event with a client',
         '[
           {"name":"calendar_detect",  "agent":null,       "prompt_template":"Detect completed meeting on calendar for {client}",               "requires_approval":false, "timeout_minutes":5},
           {"name":"transcript_pull",  "agent":null,  "prompt_template":"Pull transcript from Weaviate AudioTranscript for {client} meeting on {date}",  "requires_approval":false, "timeout_minutes":10},
           {"name":"summary_draft",    "agent":null,  "prompt_template":"Draft summary + next steps from transcript: {prev_output}",     "requires_approval":false, "timeout_minutes":30},
           {"name":"review",           "agent":null,       "prompt_template":null,                                                              "requires_approval":true,  "timeout_minutes":null},
           {"name":"deliver",          "agent":null,  "prompt_template":"Upload {output_file} to Drive; email {client} with deliverable", "requires_approval":false, "timeout_minutes":15}
         ]'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM boss_pipelines WHERE tenant_id = _tenant AND name = 'Client Meeting Followup'
  );

  -- 2. Proposal / SOW Creation
  INSERT INTO boss_pipelines (tenant_id, name, description, stages)
  SELECT _tenant,
         'Proposal / SOW',
         'Research → outline → draft → review → revise → deliver for a client proposal',
         '[
           {"name":"research",   "agent":null,  "prompt_template":"Research {client} context; pull KFR + prior SOWs",                           "requires_approval":false, "timeout_minutes":45},
           {"name":"outline",    "agent":null,  "prompt_template":"Outline proposal sections based on: {prev_output}",                           "requires_approval":false, "timeout_minutes":30},
           {"name":"draft",      "agent":null,  "prompt_template":"Draft full proposal from outline: {prev_output}",                             "requires_approval":false, "timeout_minutes":90},
           {"name":"review",     "agent":null,       "prompt_template":null,                                                                           "requires_approval":true,  "timeout_minutes":null},
           {"name":"revise",     "agent":null,  "prompt_template":"Apply feedback from review; produce final draft",                              "requires_approval":false, "timeout_minutes":45},
           {"name":"deliver",    "agent":null,  "prompt_template":"Generate PDF, upload to Drive, email {client} with cover message",            "requires_approval":false, "timeout_minutes":15}
         ]'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM boss_pipelines WHERE tenant_id = _tenant AND name = 'Proposal / SOW'
  );

  -- 3. Lead Qualification (Pessy-style inbound)
  INSERT INTO boss_pipelines (tenant_id, name, description, stages)
  SELECT _tenant,
         'Lead Qualification',
         'Inbound email → classify → draft reply → review → send',
         '[
           {"name":"email_ingest", "agent":null, "prompt_template":"Pull inbound email thread ID {thread_id}",                      "requires_approval":false, "timeout_minutes":5},
           {"name":"classify",     "agent":null, "prompt_template":"Classify as hot / warm / cold / spam based on: {prev_output}",    "requires_approval":false, "timeout_minutes":10},
           {"name":"draft_reply",  "agent":null, "prompt_template":"Draft reply appropriate for classification: {prev_output}",        "requires_approval":false, "timeout_minutes":20},
           {"name":"review",       "agent":null,      "prompt_template":null,                                                                "requires_approval":true,  "timeout_minutes":null},
           {"name":"send",         "agent":null, "prompt_template":"Send approved reply; log to CRM",                                   "requires_approval":false, "timeout_minutes":5}
         ]'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM boss_pipelines WHERE tenant_id = _tenant AND name = 'Lead Qualification'
  );

  -- 4. Content Publishing (SP Productions)
  INSERT INTO boss_pipelines (tenant_id, name, description, stages)
  SELECT _tenant,
         'Content Publishing',
         'Research → write → edit → review → publish pipeline for SP Productions',
         '[
           {"name":"research",  "agent":"maryann", "prompt_template":"Research topic: {title}; pull relevant sources",              "requires_approval":false, "timeout_minutes":30},
           {"name":"write",     "agent":"maryann", "prompt_template":"Write draft based on: {prev_output}",                          "requires_approval":false, "timeout_minutes":60},
           {"name":"edit",      "agent":"maryann", "prompt_template":"Self-edit for tone + accuracy",                                 "requires_approval":false, "timeout_minutes":20},
           {"name":"review",    "agent":null,      "prompt_template":null,                                                             "requires_approval":true,  "timeout_minutes":null},
           {"name":"publish",   "agent":"maryann", "prompt_template":"Publish to configured channels; archive",                       "requires_approval":false, "timeout_minutes":10}
         ]'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM boss_pipelines WHERE tenant_id = _tenant AND name = 'Content Publishing'
  );

  -- 5. Client Onboarding
  INSERT INTO boss_pipelines (tenant_id, name, description, stages)
  SELECT _tenant,
         'Client Onboarding',
         'Intake → assessment → KFR draft → review → present → SOW draft → review → deliver',
         '[
           {"name":"intake",        "agent":null, "prompt_template":"Intake form submitted by {client}; parse into structured profile",                       "requires_approval":false, "timeout_minutes":15},
           {"name":"assessment",    "agent":null, "prompt_template":"Run assessment against intake profile: {prev_output}",                                    "requires_approval":false, "timeout_minutes":30},
           {"name":"kfr_draft",     "agent":null, "prompt_template":"Draft Key Findings Report from assessment: {prev_output}",                                 "requires_approval":false, "timeout_minutes":45},
           {"name":"kfr_review",    "agent":null,      "prompt_template":null,                                                                                       "requires_approval":true,  "timeout_minutes":null},
           {"name":"kfr_present",   "agent":null, "prompt_template":"Deliver KFR to {client}; collect feedback",                                                "requires_approval":false, "timeout_minutes":15},
           {"name":"sow_draft",     "agent":null, "prompt_template":"Draft SOW based on KFR + feedback",                                                        "requires_approval":false, "timeout_minutes":60},
           {"name":"sow_review",    "agent":null,      "prompt_template":null,                                                                                       "requires_approval":true,  "timeout_minutes":null},
           {"name":"deliver",       "agent":null, "prompt_template":"Send final SOW; create client project folder",                                             "requires_approval":false, "timeout_minutes":15}
         ]'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM boss_pipelines WHERE tenant_id = _tenant AND name = 'Client Onboarding'
  );

END $$;
