/**
 * QuickBooks Online webhook receiver — entity change notifications.
 *
 *   POST /api/webhooks/quickbooks — Intuit delivers batched change events
 *        (invoice created, payment updated, customer merged, ...). Each
 *        delivery is signed: the `intuit-signature` header carries
 *        Base64(HMAC-SHA256(raw_body, verifier_token)). The verifier
 *        token is issued per app+environment in the Intuit developer
 *        dashboard when the webhook endpoint URL is saved there.
 *
 * Intuit requires a 200 response within 3 seconds; failed deliveries are
 * retried with backoff and can hold up subsequent events — so this handler
 * verifies, logs, and acks. Payloads carry only metadata (entity type, id,
 * operation, realm) — the brain re-queries the QuickBooks API when it cares.
 *
 * Payload shapes: current CloudEvents deliveries are a TOP-LEVEL JSON ARRAY
 * of event objects (mandatory cutover 2026-07-31); the legacy shape is an
 * object with an eventNotifications array. Both are summarized.
 *
 * No tenant context — Intuit hits us as an anonymous third party (the
 * /api/webhooks prefix is on the auth middleware public-paths list).
 *
 * Env required:
 *   - QB_WEBHOOK_VERIFIER_TOKEN — from the Intuit app's webhooks page
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface LegacyEventBody {
  eventNotifications?: Array<{
    realmId?: string;
    dataChangeEvent?: {
      entities?: Array<{ name?: string; id?: string; operation?: string; lastUpdated?: string }>;
    };
  }>;
}

interface CloudEventBody {
  specversion?: string;
  type?: string; // e.g. qbo.invoice.updated.v1
  intuitentityid?: string;
  intuitaccountid?: string;
}

export async function quickbooksWebhookRoutes(server: FastifyInstance) {
  server.post(
    '/quickbooks',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const verifierToken = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
      if (!verifierToken) {
        request.log.error('QB_WEBHOOK_VERIFIER_TOKEN not configured');
        // Ack anyway — repeated 5xx would make Intuit mark the endpoint
        // unhealthy and pause delivery. Operator sees the log.
        return reply.status(200).send({ ok: true, persisted: false, reason: 'verifier_missing' });
      }

      const sigHeader = request.headers['intuit-signature'];
      const provided = typeof sigHeader === 'string' ? sigHeader : '';
      if (!provided) {
        return reply.status(401).send({ error: 'missing signature' });
      }

      const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
      const expected = crypto
        .createHmac('sha256', verifierToken)
        .update(raw, 'utf8')
        .digest('base64');

      if (!timingSafeEqualB64(provided, expected)) {
        request.log.warn('QuickBooks webhook signature: mismatch');
        return reply.status(401).send({ error: 'invalid signature' });
      }

      const summary = summarizeQboEvent(request.body ?? {});
      request.log.info({ summary }, 'QuickBooks webhook event');

      return reply.status(200).send({ ok: true });
    },
  );
}

/** One readable line per delivery, covering both payload generations. */
function summarizeQboEvent(body: unknown): string {
  // CloudEvents-style: array of events (even single events arrive wrapped)
  if (Array.isArray(body)) {
    const parts = (body as CloudEventBody[])
      .filter((e) => e && typeof e === 'object')
      .map((e) => `${e.type ?? '?'} entity=${e.intuitentityid ?? '?'} realm=${e.intuitaccountid ?? '?'}`);
    return parts.length > 0 ? parts.join(', ') : 'empty delivery';
  }

  const obj = (body ?? {}) as LegacyEventBody & CloudEventBody;

  // CloudEvents-style single object (defensive — Intuit wraps in an array)
  if (obj.type && obj.specversion) {
    return `${obj.type} entity=${obj.intuitentityid ?? '?'} realm=${obj.intuitaccountid ?? '?'}`;
  }

  // Legacy batched shape
  const notifications = obj.eventNotifications ?? [];
  const parts: string[] = [];
  for (const n of notifications) {
    const entities = n.dataChangeEvent?.entities ?? [];
    for (const e of entities) {
      parts.push(`${e.name ?? '?'}#${e.id ?? '?'} ${e.operation ?? '?'}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'empty delivery';
}

/** Constant-time base64 string comparison; false when lengths differ. */
function timingSafeEqualB64(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
