/** Exact port of reviewed collector morphoConfiguredCapacityMath (lines 262–342).
 * Native base prongs and allocation gates; this is not an execution or source-equivalence proof. */
export type MorphoV2AdapterMathInput = {
  market: readonly bigint[]
  at: bigint
  borrowRate: bigint
  internalShares: bigint
  actualShares: bigint
  blueCash: bigint
  allowance: bigint
  idleCash: bigint
  allocations: readonly bigint[]
  enrolled: boolean
}
const MAX = (1n << 256n) - 1n
function check(ok: boolean, reason: string): asserts ok {
  if (!ok) throw Error(reason)
}
export function morphoV2AdapterCapacityMath(v: MorphoV2AdapterMathInput) {
  const u = (x: bigint, max = MAX) => {
      check(typeof x === 'bigint' && x >= 0n && x <= max, 'math_uint')
      return x
    },
    bounded = (x: bigint) => u(x),
    wad = 10n ** 18n,
    mul = (a: bigint, b: bigint, d: bigint) => bounded(a * b) / d
  check(v.market.length === 6, 'market_length')
  const [S, T, B, , last, fee] = v.market.map((x) => u(x, (1n << 128n) - 1n)),
    elapsed = u(v.at) - last
  check(elapsed >= 0n && last > 0n && fee <= wad && S >= B, 'math_clock_fee')
  const rate = u(v.borrowRate),
    internal = u(v.internalShares),
    actual = u(v.actualShares),
    cash = u(v.blueCash),
    allowance = u(v.allowance),
    idle = u(v.idleCash)
  check(internal <= actual && actual <= T, 'internal_vs_actual_shares')
  const first = bounded(rate * elapsed),
    second = mul(first, first, 2n * wad),
    third = mul(second, first, 3n * wad),
    interest = mul(B, bounded(first + second + third), wad),
    s = u(S + interest, (1n << 128n) - 1n),
    b = u(B + interest, (1n << 128n) - 1n),
    feeAssets = mul(interest, fee, wad),
    feeShares = mul(feeAssets, bounded(T + 1000000n), bounded(s - feeAssets + 1n)),
    t = u(T + feeShares, (1n << 128n) - 1n)
  const positionAssets = mul(internal, bounded(s + 1n), bounded(t + 1000000n)),
    liquidity = s >= b ? s - b : 0n,
    base = [positionAssets, liquidity, cash, allowance].reduce((a, b) => (a < b ? a : b)),
    intMax = (1n << 255n) - 1n,
    allocations = v.allocations.map((x) => u(x, intMax)),
    enabled = v.enrolled === true && allocations.length === 3 && allocations.every((x) => x > 0n)
  // Positive changes are largest before withdrawal; reject signed-add overflow before
  // searching the monotone lower-allocation boundary of positive withdrawals.
  const oldAllocation = allocations[2] ?? 0n,
    positiveChange = positionAssets > oldAllocation ? positionAssets - oldAllocation : 0n
  check(
    positionAssets <= intMax && allocations.every((a) => a + positiveChange <= intMax),
    'allocation_int_overflow',
  )
  const qualifies = (x: bigint) => {
    if (x === 0n) return true // Idle cash does not invoke the adapter.
    if (!enabled) return false
    const numerator = bounded(x * bounded(t + 1000000n)),
      denominator = bounded(s + 1n),
      burned = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n)
    check(burned <= internal && burned <= t && x <= s, 'withdrawal_state_underflow')
    const remaining = mul(internal - burned, bounded(s - x + 1n), bounded(t - burned + 1000000n)),
      change = remaining - oldAllocation
    check(change >= -intMax && change <= intMax, 'allocation_change_overflow')
    return allocations.every((a) => a + change >= 0n && a + change <= intMax)
  }
  let pullable = 0n
  if (enabled && qualifies(base)) pullable = base
  else if (enabled) {
    let lo = 0n,
      hi = base
    // Native uint256 quantities require at most 256 bisections.
    while (lo < hi) {
      const mid = lo + (hi - lo + 1n) / 2n
      if (qualifies(mid)) lo = mid
      else hi = mid - 1n
    }
    pullable = lo
  }
  return {
    interestRaw: String(interest),
    feeSharesRaw: String(feeShares),
    accruedSupplyAssetsRaw: String(s),
    accruedSupplySharesRaw: String(t),
    accruedBorrowAssetsRaw: String(b),
    internalPositionAssetsRaw: String(positionAssets),
    marketLiquidityRaw: String(liquidity),
    configuredAdapterLiquidityBoundRaw: String(base),
    conditionalAllocationQualifiedPullableRaw: String(pullable),
    configuredAdapterPullableRaw: String(pullable),
    conditionalProtocolCapacityRaw: String(bounded(idle + pullable)),
    adapterEnrollmentAndPositiveAllocationsObserved: enabled,
    postWithdrawalAllocationGate: 'computed_from_share_burn_and_all_three_caps',
  }
}
