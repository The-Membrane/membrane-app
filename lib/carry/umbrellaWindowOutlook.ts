/** A checked-block schedule, conditional on the cooldown settings staying unchanged. */
export function umbrellaWindowAtHorizon(
  blockTime: string,
  cooldownEnd: number,
  windowEndInclusive: number,
  horizonHours: number,
): string | null {
  const blockSeconds = Date.parse(blockTime) / 1000
  if (
    !Number.isFinite(blockSeconds) ||
    !Number.isSafeInteger(cooldownEnd) ||
    !Number.isSafeInteger(windowEndInclusive) ||
    cooldownEnd > windowEndInclusive ||
    !Number.isFinite(horizonHours) ||
    horizonHours < 0
  )
    return null
  const targetSeconds = blockSeconds + horizonHours * 3600
  return targetSeconds < cooldownEnd
    ? `+${horizonHours}h: cooldown waiting`
    : targetSeconds <= windowEndInclusive
      ? `+${horizonHours}h: within scheduled window`
      : `+${horizonHours}h: scheduled window closed`
}
