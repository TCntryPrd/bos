/**
 * Tenant resolution for the fusion control plane.
 *
 * Fusion tables store `tenant_id TEXT` (app-seeded), with no hard FK to tenants until
 * the ghost-tenant backfill lands (see deploy/migrations/001_tenant_resolver.sql). On
 * last-castle the canonical id is DEFAULT_TENANT_ID (d05cde41…); 'default' is the dev
 * fallback. This collapses the dev 'default' sentinel onto the real tenant so fusion
 * rows never strand on a non-existent id.
 */
export function currentTenantId(explicit?: string | null): string {
  if (explicit && explicit !== 'default') return explicit;
  return process.env.DEFAULT_TENANT_ID || 'default';
}
