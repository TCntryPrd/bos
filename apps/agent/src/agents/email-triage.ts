/**
 * Email triage — placeholder. Will be moved from apps/api.
 * On the host, this has direct Google API access without token decryption hacks.
 */

export function startEmailTriage(): void {
  console.log('[email-triage] Host-native email triage starting (15 min interval)');
  // Will be wired up when full migration completes
}

export function stopEmailTriage(): void {
  console.log('[email-triage] Stopped');
}
