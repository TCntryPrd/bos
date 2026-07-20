import { getPool } from '../db.js';
import { callBridge, jsonlPathFor } from './host-bridge.js';
import { recoverFinalAssistantFrame } from './agent-interactive.js';
import { agentRuntimeId, type AgentRuntimeKind } from './agent-runtime-id.js';
import { finishAgentTurn, ingestAgentRecap } from './agent-memory.js';

interface RecoverableTurn {
  id: string;
  tenant_id: string;
  agent_kind: AgentRuntimeKind;
  handle: string;
  assistant_message_id: string;
  cli_session_id: string | null;
  project_dir: string | null;
  started_at: Date | string | null;
  created_at: Date | string;
}

interface RecoveryLogger {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
}

/**
 * Finalize turns whose API tailer disappeared but whose host watcher returned
 * Claude to its permanent shell. Recent idle rows are left alone so a startup
 * race cannot fail a turn before agent-start has launched the process.
 */
export async function recoverAbandonedAgentTurns(log: RecoveryLogger): Promise<void> {
  const result = await getPool().query<RecoverableTurn>(`
    SELECT t.id, t.tenant_id, t.agent_kind, t.handle, t.assistant_message_id,
           t.cli_session_id, r.project_dir, t.started_at, t.created_at
      FROM boss_agent_turns t
      JOIN boss_rascals r
        ON t.agent_kind='rascal' AND r.tenant_id=t.tenant_id AND r.handle=t.handle
     WHERE t.status IN ('queued','starting','running','interrupting')
    UNION ALL
    SELECT t.id, t.tenant_id, t.agent_kind, t.handle, t.assistant_message_id,
           t.cli_session_id, o.project_dir, t.started_at, t.created_at
      FROM boss_agent_turns t
      JOIN boss_outsiders o
        ON t.agent_kind='outsider' AND o.tenant_id=t.tenant_id AND o.handle=t.handle
     WHERE t.status IN ('queued','starting','running','interrupting')
  `);

  const outcomes = await Promise.allSettled(result.rows.map(async (turn) => {
    const runtimeId = agentRuntimeId(turn.tenant_id, turn.agent_kind, turn.handle);
    const status = await callBridge('agent-status', [runtimeId], { timeoutMs: 5_000 });
    if (status.busy === true) return;

    const since = new Date(turn.started_at ?? turn.created_at).getTime() - 2_000;
    const ageMs = Date.now() - new Date(turn.started_at ?? turn.created_at).getTime();
    const recovered = turn.cli_session_id && turn.project_dir
      ? await recoverFinalAssistantFrame(jsonlPathFor(turn.project_dir, turn.cli_session_id), since)
      : { text: '', tokensIn: null, tokensOut: null };

    if (recovered.text) {
      await getPool().query(
        `UPDATE boss_chat_messages
            SET content=$2, tokens_in=$3, tokens_out=$4
          WHERE id=$1`,
        [turn.assistant_message_id, recovered.text, recovered.tokensIn, recovered.tokensOut],
      );
      const recap = await finishAgentTurn(turn.id, 'completed', recovered.text);
      if (recap) {
        await ingestAgentRecap(turn.tenant_id, turn.agent_kind, turn.handle, turn.id, recap);
      }
      log.info({ turnId: turn.id, handle: turn.handle }, 'recovered completed agent turn after API restart');
      return;
    }

    if (ageMs < 120_000) return;
    const failed = await getPool().query<{ content: string }>(
      `UPDATE boss_chat_messages
          SET content = CASE
            WHEN COALESCE(content,'') = '' THEN '[turn interrupted by runtime restart]'
            ELSE content || E'\n\n[turn interrupted by runtime restart]'
          END
        WHERE id=$1
        RETURNING content`,
      [turn.assistant_message_id],
    );
    await finishAgentTurn(
      turn.id,
      'failed',
      failed.rows[0]?.content ?? '',
      'host process ended without a final end_turn frame',
    );
    log.warn({ turnId: turn.id, handle: turn.handle }, 'closed abandoned agent turn without final response');
  }));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      log.warn({ err: outcome.reason, turnId: result.rows[index]?.id }, 'agent turn recovery failed');
    }
  });
}
