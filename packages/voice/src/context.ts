/**
 * Room awareness — enriches brain requests with the source room context.
 * BOS knows which device issued a command and injects that into processing.
 */

import type { DeviceRegistry, VoiceDevice } from './devices.js';

export interface RoomContext {
  deviceId: string;
  room: string;
  /** Additional context hints the brain should receive. */
  contextHints: string[];
}

/**
 * Build a RoomContext from a device ID.
 * Returns undefined if the device is unknown.
 */
export function buildRoomContext(
  deviceId: string,
  registry: DeviceRegistry,
): RoomContext | undefined {
  const device = registry.get(deviceId);
  if (!device) return undefined;

  return {
    deviceId: device.id,
    room: device.room,
    contextHints: buildHints(device),
  };
}

/**
 * Produce natural-language context hints for the brain based on room.
 * Example: "The user spoke from the bedroom. Treat ambiguous device or location references
 * as referring to the bedroom unless stated otherwise."
 */
export function buildHints(device: VoiceDevice): string[] {
  return [
    `The user is speaking from the ${device.room}.`,
    `When location context is ambiguous, assume the ${device.room} unless the user specifies otherwise.`,
  ];
}

/**
 * Format a RoomContext as a string suitable for injecting into a brain prompt.
 */
export function formatContextForPrompt(ctx: RoomContext): string {
  return `[Room context: ${ctx.room}] ${ctx.contextHints.join(' ')}`;
}

/**
 * Determine whether a command is likely room-scoped (e.g. "turn off the lights")
 * vs. explicitly global (e.g. "turn off all lights in the house").
 *
 * This is a lightweight heuristic — the brain can override with reasoning.
 */
export function isRoomScoped(transcript: string): boolean {
  const globalPhrases = [
    'everywhere',
    'whole house',
    'all rooms',
    'entire house',
    'every room',
  ];
  const lower = transcript.toLowerCase();
  return !globalPhrases.some((phrase) => lower.includes(phrase));
}
