// =============================================================================
// Native context usage
// =============================================================================

// The agent's latest context count and capacity in tokens, never cumulative billing usage.
export type ContextUsage = { used: number; size: number };

export function contextUsage(used: unknown, size: unknown): ContextUsage | undefined {
  if (
    typeof used !== 'number' ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(used) ||
    !Number.isSafeInteger(size) ||
    used < 0 ||
    size <= 0
  )
    return undefined;
  return { used, size };
}
