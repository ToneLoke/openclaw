/**
 * Per-channel rate limiter for sibling bot messages in multi-agent Discord setups.
 *
 * Without rate limiting, a single message in a shared channel can trigger a
 * cascade: each sibling bot responds, and every response is seen by every other
 * bot (via the sibling-bots pass-through), causing an amplification loop.
 *
 * This module tracks processed sibling messages per (accountId, channelId) and
 * drops messages that arrive too quickly or exceed the per-window cap.
 */

export interface SiblingBotRateLimiterConfig {
  /** Minimum ms between processed sibling messages per channel. Default: 30_000 (30s) */
  cooldownMs?: number;
  /** Max sibling messages to process per window. Default: 3 */
  maxPerWindow?: number;
  /** Rolling window duration in ms. Default: 300_000 (5 min) */
  windowMs?: number;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_PER_WINDOW = 3;
const DEFAULT_WINDOW_MS = 300_000;

type ChannelState = {
  lastProcessedAt: number;
  windowEntries: number[]; // timestamps of processed messages in current window
};

const stateMap = new Map<string, ChannelState>();

function stateKey(accountId: string, channelId: string): string {
  return `${accountId}:${channelId}`;
}

function pruneWindow(entries: number[], windowMs: number, now: number): number[] {
  return entries.filter((ts) => now - ts < windowMs);
}

/**
 * Returns true if the sibling message should be dropped (rate limited).
 * Human messages are never passed through this function — call site guards that.
 */
export function isSiblingRateLimited(
  accountId: string,
  channelId: string,
  config: SiblingBotRateLimiterConfig,
): boolean {
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxPerWindow = config.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;

  const key = stateKey(accountId, channelId);
  const now = Date.now();
  const state = stateMap.get(key);

  if (!state) {
    // No prior state — first sibling message, allow it
    return false;
  }

  // Cooldown check: too soon since last processed message
  if (now - state.lastProcessedAt < cooldownMs) {
    return true;
  }

  // Window cap check: too many messages in rolling window
  const active = pruneWindow(state.windowEntries, windowMs, now);
  if (active.length >= maxPerWindow) {
    return true;
  }

  return false;
}

/**
 * Record that a sibling message was successfully processed for this channel.
 * Call this after confirming the message will be handled (not dropped).
 */
export function recordSiblingProcessed(accountId: string, channelId: string): void {
  const key = stateKey(accountId, channelId);
  const now = Date.now();
  const existing = stateMap.get(key);

  if (!existing) {
    stateMap.set(key, {
      lastProcessedAt: now,
      windowEntries: [now],
    });
    return;
  }

  // Prune stale window entries using the default window (config not available here;
  // pruning is best-effort — isSiblingRateLimited does the authoritative prune)
  const pruned = pruneWindow(existing.windowEntries, DEFAULT_WINDOW_MS, now);
  pruned.push(now);

  stateMap.set(key, {
    lastProcessedAt: now,
    windowEntries: pruned,
  });
}

/** Clear all state — used in tests and for clean shutdown. */
export function clearSiblingRateLimiterState(): void {
  stateMap.clear();
}
