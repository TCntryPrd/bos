/**
 * risk.ts — the Chief-of-Staff RISK axis (Fusion P1).
 *
 * Risk is ORTHOGONAL to trust (tools/trust.ts):
 *   trust = WHO may call a tool (observer/assistant/operator/admin) — fail-closed LOW.
 *   risk  = HOW dangerous the action is (0 read .. 3 irreversible/financial) — fail-safe HIGH
 *           (an unknown tool is treated as tier 2, so new/un-classified tools need approval).
 *
 * A tool whose effective risk tier exceeds the tenant's autonomy ceiling is NOT executed:
 * a pending row is written to boss_approvals and a "⏸ queued for approval" string is
 * returned to the caller (brain loop, persistent-agent runner, kevin-intel — all paths).
 * The principal approves/denies from the "Needs Your OK" dashboard tile; on approve the
 * tool runs with the gate bypassed (ctx.approvedApprovalId set).
 *
 * The gate is FAIL-OPEN only on missing infrastructure (tables not migrated yet) so a
 * partial deploy never bricks tool execution; once the migrations land it is active.
 */
import { getPool } from '../db.js';
import { currentTenantId } from '../lib/tenant.js';
import { toolMinTrust, type TrustTier } from './trust.js';

export type RiskTier = 0 | 1 | 2 | 3;

// Trust tier -> base risk tier. The registry's trust map already classifies every tool
// (observer=read, assistant=create/send, operator=trigger/modify, admin=delete/config),
// so it is the most accurate base. EXPLICIT_RISK below overrides the exceptions (e.g.
// gmail_send is assistant-trust but external-comms risk 2).
const TRUST_TO_RISK: Record<TrustTier, RiskTier> = { observer: 0, assistant: 1, operator: 2, admin: 3 };

export interface ToolCtx {
  tenantId: string;
  userId?: string;
  conversationId?: string;
  agentName?: string;
  /** When set, this call is executing an ALREADY-approved tool — the gate is bypassed. */
  approvedApprovalId?: string;
}

export interface GateResult {
  allow: boolean;
  tier: RiskTier;
  pendingResult?: string;
}

// ── Explicit classification for the sensitive, well-known tools (precision over patterns) ──
const EXPLICIT_RISK: Record<string, RiskTier> = {
  // tier 3 — irreversible / financial / self+host modification
  boss_bash: 3, boss_self_patch: 3, boss_self_build: 3, boss_self_git: 3, boss_self_test: 3,
  boss_self_introspect: 3, boss_self_grep: 3, boss_host_apt: 3, boss_host_systemctl: 3,
  boss_host_cron: 3, boss_stripe_create_invoice: 3, boss_github_push_tag: 3,
  // tier 2 — external comms / public surface
  boss_gmail_send: 2, boss_gmail_reply: 2, boss_gmail_quick_ack: 2,
  boss_slack_send_message: 2, boss_telegram_send_message: 2, boss_telegram_send_and_wait: 2,
  meta_fb_send_message: 2, meta_fb_publish_post: 2, meta_ig_publish_post: 2,
  meta_threads_publish: 2, meta_wa_send: 2, boss_linkedin_post: 2,
  boss_n8n_run_workflow: 2, boss_make_run_scenario: 2, boss_github_open_pr: 2,
  boss_ha_turn_on: 2, boss_ha_turn_off: 2, boss_ha_run_automation: 2,
  // tier 1 — internal write (explicit, where a pattern would misread)
  boss_gmail_draft: 1, boss_gmail_draft_reply: 1, boss_gmail_label: 1,
  boss_gmail_archive: 1, boss_gmail_mark_read: 1, boss_tasks_create: 1,
  boss_knowledge_ingest: 1, boss_memory_save: 1,
  // tier 0 — read (explicit)
  boss_route_client_email: 0, boss_triage_reason: 0, boss_financial_reason: 0,
};

const RE_TIER3 = /(^|_)(delete|destroy|drop|purge|wipe|remove)(_|$)|transfer|payout|refund|wire|send_money|initiate_payment|create_base|create_scenario|update_scenario/i;
const RE_TIER2 = /(^|_)(send|post|publish|reply|share|message|dm|tweet|sms|call|invite|email|activate|deactivate)(_|$)|_send$|_post$|_publish$/i;
const RE_TIER1 = /(^|_)(create|update|write|append|ingest|save|upsert|set|move|assign|advance|block|complete|configure|draft|label|archive|mark|tag|classify|record)(_|$)/i;
const RE_TIER0 = /(^|_)(list|get|search|read|status|recent|pending|today|upcoming|fetch|summary|count|metrics|overview|digest|info|history|usage|accounts|balance|insights|attention)(_|$)/i;

/** Pure, synchronous classification by tool name (+ light arg heuristics). */
export function effectiveTier(toolName: string, args: Record<string, unknown> = {}): RiskTier {
  let tier: RiskTier;
  const trust = toolMinTrust(toolName);
  if (toolName in EXPLICIT_RISK) tier = EXPLICIT_RISK[toolName];           // exceptions (comms/financial)
  else if (trust) tier = TRUST_TO_RISK[trust];                            // registry trust classification
  else if (RE_TIER3.test(toolName)) tier = 3;                            // pattern fallback for unlisted tools
  else if (RE_TIER2.test(toolName)) tier = 2;
  else if (RE_TIER1.test(toolName)) tier = 1;
  else if (RE_TIER0.test(toolName)) tier = 0;
  else tier = 2; // truly unknown -> fail-safe HIGH

  // Arg heuristic: a meaningful money amount escalates to financial (tier 3).
  const amt = Number((args.amount ?? args.value ?? args.total) as number);
  if (Number.isFinite(amt) && amt >= 100) tier = 3;

  // Runtime override from boss_tool_meta (cached).
  const ov = overrideCache.get(toolName);
  if (ov !== undefined && ov !== null) tier = ov as RiskTier;
  return tier;
}

/** Human-readable "I am about to …" line for the approval card. */
export function commitMessage(toolName: string, args: Record<string, unknown> = {}): string {
  const hint = (args.to ?? args.recipient ?? args.channel ?? args.title ?? args.subject ?? args.query ?? args.workflowId ?? args.scenarioId ?? '') as string;
  const pretty = toolName.replace(/^boss_|^meta_/, '').replace(/_/g, ' ');
  return hint ? `Run ${pretty} → ${String(hint).slice(0, 80)}` : `Run ${pretty}`;
}

// ── Caches (avoid a DB hit on every tool call) ────────────────────────────────
const overrideCache = new Map<string, number | null>();
let overrideAt = 0;
const ceilingCache = new Map<string, RiskTier>();
let ceilingAt = 0;
let gateEnabledFlag: boolean | null = null;
let gateEnabledAt = 0;

async function gateEnabled(): Promise<boolean> {
  if (gateEnabledFlag !== null && Date.now() - gateEnabledAt < 60_000) return gateEnabledFlag;
  try {
    const { rows } = await getPool().query<{ ok: boolean }>(`SELECT to_regclass('public.boss_approvals') IS NOT NULL AS ok`);
    gateEnabledFlag = !!rows[0]?.ok;
  } catch { gateEnabledFlag = false; }
  gateEnabledAt = Date.now();
  return gateEnabledFlag;
}

async function refreshOverrides(): Promise<void> {
  if (Date.now() - overrideAt < 300_000) return;
  overrideAt = Date.now();
  try {
    const { rows } = await getPool().query<{ tool_name: string; risk_tier: number | null }>(`SELECT tool_name, risk_tier FROM boss_tool_meta`);
    overrideCache.clear();
    for (const r of rows) overrideCache.set(r.tool_name, r.risk_tier);
  } catch { /* table may not exist yet */ }
}

async function autonomyCeiling(tenantId: string): Promise<RiskTier> {
  const t = currentTenantId(tenantId);
  const envDefault = (Number(process.env.BOSS_AUTONOMY_CEILING ?? '1') || 1) as RiskTier;
  if (Date.now() - ceilingAt > 60_000) {
    ceilingAt = Date.now();
    ceilingCache.clear();
    try {
      const { rows } = await getPool().query<{ tenant_id: string; max_auto_risk_tier: number }>(
        `SELECT tenant_id, max_auto_risk_tier FROM boss_autonomy_policy WHERE scope = 'default'`);
      for (const r of rows) ceilingCache.set(r.tenant_id, r.max_auto_risk_tier as RiskTier);
    } catch { /* table may not exist yet */ }
  }
  return ceilingCache.get(t) ?? envDefault;
}

/** Append-only audit write (best-effort; never throws into the caller). */
export async function audit(tenantId: string, actor: string, action: string, detail: unknown): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO boss_cos_audit (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)`,
      [currentTenantId(tenantId), actor, action, JSON.stringify(detail ?? {})]);
  } catch { /* audit is best-effort */ }
}

/** Forensic invocation record (tier>=1 only; fire-and-forget). */
export function recordExecuted(toolName: string, tier: RiskTier, ctx: ToolCtx, latencyMs: number): void {
  if (tier < 1) return;
  getPool().query(
    `INSERT INTO boss_tool_invocations (tenant_id,user_id,conversation_id,agent_name,tool_name,risk_tier,status,latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,'executed',$7)`,
    [currentTenantId(ctx.tenantId), ctx.userId ?? null, ctx.conversationId ?? null, ctx.agentName ?? null, toolName, tier, Math.round(latencyMs)],
  ).catch(() => { /* forensics best-effort */ });
}

/**
 * The gate. Called by executeTool before dispatching a handler.
 * Returns { allow:true } to execute, or { allow:false, pendingResult } when an approval
 * was created and the tool must NOT run.
 */
export async function gateToolCall(toolName: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<GateResult> {
  await refreshOverrides();
  const tier = effectiveTier(toolName, args);
  if (ctx.approvedApprovalId) return { allow: true, tier };      // executing an approved action
  if (!(await gateEnabled())) return { allow: true, tier };      // infra not migrated yet -> pre-fusion behavior
  const ceiling = await autonomyCeiling(ctx.tenantId);
  if (tier <= ceiling) return { allow: true, tier };

  // Above ceiling -> queue for human approval, do NOT execute.
  const message = commitMessage(toolName, args);
  const tenantId = currentTenantId(ctx.tenantId);
  try {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO boss_approvals (tenant_id,user_id,conversation_id,agent_name,tool_name,tool_args,risk_tier,commit_message)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
      [tenantId, ctx.userId ?? null, ctx.conversationId ?? null, ctx.agentName ?? null, toolName, JSON.stringify(args ?? {}), tier, message]);
    const id = rows[0].id;
    getPool().query(
      `INSERT INTO boss_tool_invocations (tenant_id,user_id,conversation_id,agent_name,tool_name,risk_tier,status,approval_id)
       VALUES ($1,$2,$3,$4,$5,$6,'pending_approval',$7)`,
      [tenantId, ctx.userId ?? null, ctx.conversationId ?? null, ctx.agentName ?? null, toolName, tier, id]).catch(() => {});
    void audit(tenantId, ctx.userId ?? ctx.agentName ?? 'system', 'approval.created', { id, toolName, tier, message });
    return {
      allow: false,
      tier,
      pendingResult: `⏸ APPROVAL REQUIRED — this action was NOT executed. ${message} (risk tier ${tier}). ` +
        `It is queued for the principal in the "Needs Your OK" dashboard tile (approval ${id}). ` +
        `Tell the principal you've queued it and continue with anything else; do not retry this same action.`,
    };
  } catch (err) {
    // If the approval write itself fails, fail OPEN (preserve pre-fusion behavior) but loudly.
    // eslint-disable-next-line no-console
    console.error('[risk] approval insert failed, allowing tool (fail-open):', (err as Error).message);
    return { allow: true, tier };
  }
}
