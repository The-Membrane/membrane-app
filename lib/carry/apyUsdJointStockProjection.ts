import { projectApyUsdNet, validApyUsdFeeCurve, type ApyUsdFeeCurve } from './apyUsdFeeOutlook'

export type ApyUsdJointSource = {
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
  finalized: true
}
/** Unsigned native observations. A separate protected issuer must replay and bind their provenance. */
export type ApyUsdJointReceipt = {
  tokenId: string
  escrowRaw: string
  fullNetEaRaw: string
  createdAtUtc: string
  claimableAtUtc: string
  fullClaimSimulation: boolean
  /** Unsigned classification; only the protected native replayer may establish its evidence. */
  claimSimulationStatus?: 'succeeded' | 'native_time_gate' | 'unexplained_revert'
}
export type ApyUsdJointCurrent = {
  source: ApyUsdJointSource
  readAtUtc: string
  profileId: string
  runtimeRegime: string
  assetDecimals: number
  shareDecimals: number
  fullSharesRaw: string
  /** Native previewRedeem(full S): vault unlocking fee is already included. */
  fullEscrowEaRaw: string
  fullGrossAssetsRaw: string
  vaultUnlockingFeeWad: string
  vaultCashRaw: string | null
  vestedAmountRaw: string | null
  totalAssetsAccountingRaw?: string
  receiptCashRaw: string | null
  vaultPaused: boolean
  receiptPaused: boolean
  fullShareInitiationSimulation: boolean
  /** Unsigned classification; the native codec must replay the exact simulation error. */
  shareInitiationSimulationStatus?: 'succeeded' | 'native_funding_gate' | 'unexplained_revert'
  feeCurve: ApyUsdFeeCurve
  existingReceipt: ApyUsdJointReceipt | null
  receiptInventory?: {
    nativeOwnedCountRaw: string
    complete: boolean
    receipts: readonly ApyUsdJointReceipt[]
  }
}
export type ApyUsdJointHistoryPoint = {
  source: ApyUsdJointSource
  acquiredAtUtc: string
  profileId: string
  runtimeRegime: string
  assetDecimals: number
  shareDecimals: number
  fullSharesRaw: string
  fullEscrowEaRaw: string | null
  fullGrossAssetsRaw: string | null
  vaultCashRaw: string | null
  vestedAmountRaw: string | null
  /** Diagnostic custody stock only; ordinary other-NFT claims do not impair reserved escrow. */
  receiptCashRaw: string | null
  owner: null
  historicalOwnership: false
}
export type ApyUsdJointStockProjectionInput = {
  current: ApyUsdJointCurrent
  history: readonly ApyUsdJointHistoryPoint[]
  question: {
    issuedAtUtc: string
    horizonHours: number
    plannedInitiationOffsetSeconds: number
    requestedRaw: string
  }
  fundingBasis?: 'native_liquid_cash' | 'cash_plus_vested_assumption'
}
export type ApyUsdJointMeasurement = {
  availableRaw: string | null
  headroomRaw: string | null
  knownFundedNetRaw: string | null
  vaultFundingExhausted: boolean
  grossQuoteFloored: boolean
  hypotheticalMintAtUtc: string | null
  existingNetRaw: string | null
  receiptDiagnostics: {
    tokenId: string
    eligible: boolean
    reservationQualified: boolean
    netRaw: string | null
  }[]
  newNetRaw: string | null
  frozenNewEscrowRaw: string | null
  initiation: 'not_yet_planned' | 'hypothetically_funded' | 'not_initiated' | 'censored'
  censorReasons: string[]
}
export type ApyUsdJointScenario = {
  fromIndex: number
  donorPeriodMs: number
  signedNetDelta: { vaultFundingRaw: string; fullEscrowEaRaw: string; fullGrossAssetsRaw: string }
  target: ApyUsdJointMeasurement
  checkpoints: ({ elapsedMs: number; atUtc: string } & ApyUsdJointMeasurement)[]
  firstSampledInsufficiencyMs: number | null
  firstSampledRecoveryMs: number | null
  firstSampledVaultExhaustionMs: number | null
  unknownBetweenCheckpoints: true
}
const MAX = (1n << 256n) - 1n
const WAD = 10n ** 18n
const DAY = 86400000
const TTL = 1800000
function check(ok: unknown): asserts ok {
  if (!ok) throw Error('invalid_apy_joint_input')
}
function uint(v: unknown): bigint {
  check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v))
  const n = BigInt(v)
  check(n <= MAX)
  return n
}
function clock(v: unknown): number {
  check(typeof v === 'string' && v.length <= 32)
  const n = Date.parse(v)
  check(Number.isSafeInteger(n) && n >= 0 && new Date(n).toISOString() === v)
  return n
}
function decimals(v: unknown): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 36
}
function source(s: ApyUsdJointSource): number {
  check(
    s.chainId === 1 &&
      s.finalized === true &&
      Number.isSafeInteger(s.blockNumber) &&
      s.blockNumber > 0,
  )
  check(typeof s.blockHash === 'string' && /^0x[0-9a-f]{64}$/.test(s.blockHash))
  const at = clock(s.blockTime)
  check(at % 1000 === 0)
  return at
}
function snapshot<T>(value: T): T {
  let nodes = 0,
    bytes = 0
  const ancestors = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= 10000 && depth <= 16)
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v))
      return v
    }
    if (typeof v === 'string') {
      bytes += v.length * 2
      check(v.length <= 2048 && bytes <= 262144)
      return v
    }
    check(v && typeof v === 'object' && !ancestors.has(v))
    const array = Array.isArray(v)
    check(Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype))
    const keys = Reflect.ownKeys(v)
    check(keys.every((k) => typeof k === 'string'))
    ancestors.add(v)
    let out: unknown
    if (array) {
      check(v.length <= 128 && keys.length === v.length + 1)
      out = Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i))
        check(d?.enumerable && Object.hasOwn(d, 'value'))
        return copy(d.value, depth + 1)
      })
    } else {
      check(keys.length <= 32)
      out = Object.create(null)
      for (const k of keys as string[]) {
        const d = Object.getOwnPropertyDescriptor(v, k)
        check(d?.enumerable && Object.hasOwn(d, 'value'))
        Object.defineProperty(out, k, { value: copy(d.value, depth + 1), enumerable: true })
      }
    }
    ancestors.delete(v)
    return out
  }
  return copy(value, 0) as T
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function floor(a: bigint, b: bigint): bigint {
  return a / b - (a < 0n && a % b !== 0n ? 1n : 0n)
}
function distribution(values: bigint[]) {
  if (!values.length) return null
  const a = [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
  return {
    band: {
      minRaw: a[0].toString(),
      p10Raw: a[Math.floor((a.length - 1) / 10)].toString(),
      p90Raw: a[Math.ceil(((a.length - 1) * 9) / 10)].toString(),
      maxRaw: a[a.length - 1].toString(),
    },
    sampleCount: a.length,
  }
}
/** Conditional custody/reservation scenarios, not acquisition approval or calibrated probabilities. */
export function buildApyUsdJointStockProjection(supplied: ApyUsdJointStockProjectionInput) {
  try {
    const input = snapshot(supplied),
      c = input.current,
      q = input.question
    const issue = clock(q.issuedAtUtc),
      src = source(c.source),
      read = clock(c.readAtUtc)
    check(src <= read && read <= issue && issue - src <= TTL)
    check(Number.isSafeInteger(q.horizonHours) && q.horizonHours >= 1 && q.horizonHours <= 720)
    check(
      Number.isSafeInteger(q.plannedInitiationOffsetSeconds) &&
        q.plannedInitiationOffsetSeconds >= 0 &&
        q.plannedInitiationOffsetSeconds <= 30 * 86400,
    )
    check(decimals(c.assetDecimals) && decimals(c.shareDecimals))
    check(
      typeof c.profileId === 'string' &&
        c.profileId.length > 0 &&
        typeof c.runtimeRegime === 'string' &&
        c.runtimeRegime.length > 0,
    )
    check(
      typeof c.vaultPaused === 'boolean' &&
        typeof c.receiptPaused === 'boolean' &&
        typeof c.fullShareInitiationSimulation === 'boolean',
    )
    check(validApyUsdFeeCurve(c.feeCurve) && projectApyUsdNet('1', 0, c.feeCurve))
    for (const v of [c.feeCurve.minFeeWad, c.feeCurve.maxFeeWad, c.feeCurve.curvatureWad]) uint(v)
    const S = uint(c.fullSharesRaw),
      ea = uint(c.fullEscrowEaRaw),
      gross = uint(c.fullGrossAssetsRaw),
      Q = uint(q.requestedRaw)
    check(Q > 0n)
    const vaultFee = uint(c.vaultUnlockingFeeWad)
    check(vaultFee <= WAD / 100n)
    const escrowFromGross = (g: bigint) =>
      g - (g * vaultFee + WAD + vaultFee - 1n) / (WAD + vaultFee)
    const requiredFunding = (e: bigint) => e + (e * vaultFee + WAD - 1n) / WAD
    check(ea <= gross && (S !== 0n || gross === 0n))
    const feePolicyMatches = ea === escrowFromGross(gross)
    const nullable = (v: string | null) => (v === null ? null : uint(v))
    const cash = nullable(c.vaultCashRaw),
      vested = nullable(c.vestedAmountRaw),
      receiptCash = nullable(c.receiptCashRaw)
    if (c.totalAssetsAccountingRaw !== undefined) uint(c.totalAssetsAccountingRaw)
    const basis = input.fundingBasis === undefined ? 'native_liquid_cash' : input.fundingBasis
    check(basis === 'native_liquid_cash' || basis === 'cash_plus_vested_assumption')
    const funding =
      cash === null || (basis === 'cash_plus_vested_assumption' && vested === null)
        ? null
        : cash + (basis === 'cash_plus_vested_assumption' ? vested! : 0n)
    check(funding === null || funding <= MAX)
    const shareSimulationStatus =
      c.shareInitiationSimulationStatus === undefined
        ? c.fullShareInitiationSimulation
          ? 'succeeded'
          : 'unexplained_revert'
        : c.shareInitiationSimulationStatus
    check(
      shareSimulationStatus === 'succeeded' ||
        shareSimulationStatus === 'native_funding_gate' ||
        shareSimulationStatus === 'unexplained_revert',
    )
    if (shareSimulationStatus === 'succeeded') check(c.fullShareInitiationSimulation)
    else check(!c.fullShareInitiationSimulation)
    if (shareSimulationStatus === 'native_funding_gate')
      check(
        S > 0n &&
          !c.vaultPaused &&
          !c.receiptPaused &&
          feePolicyMatches &&
          funding !== null &&
          funding < requiredFunding(ea),
      )
    const inventory = c.receiptInventory
    check(c.existingReceipt === null || inventory === undefined)
    let scopeComplete = true
    let receipts: readonly ApyUsdJointReceipt[] =
      c.existingReceipt === null ? [] : [c.existingReceipt]
    if (inventory !== undefined) {
      check(
        typeof inventory.complete === 'boolean' &&
          Array.isArray(inventory.receipts) &&
          inventory.receipts.length <= 64,
      )
      const count = uint(inventory.nativeOwnedCountRaw)
      check(BigInt(inventory.receipts.length) <= count)
      check(!inventory.complete || count === BigInt(inventory.receipts.length))
      scopeComplete = inventory.complete
      receipts = inventory.receipts
    }
    const ids = new Set<string>()
    let ownedEscrow = 0n
    const oldReceipts = receipts.map((old) => {
      uint(old.tokenId)
      check(!ids.has(old.tokenId))
      ids.add(old.tokenId)
      const oldEscrow = uint(old.escrowRaw)
      ownedEscrow += oldEscrow
      check(ownedEscrow <= MAX)
      const oldCreated = clock(old.createdAtUtc),
        oldOpening = clock(old.claimableAtUtc)
      check(
        oldCreated <= src &&
          (oldEscrow === 0n || oldCreated > 0) &&
          oldCreated % 1000 === 0 &&
          oldOpening % 1000 === 0 &&
          ((oldEscrow === 0n && oldCreated === 0 && oldOpening === 0) ||
            oldOpening === oldCreated + c.feeCurve.minDurationSeconds * 1000) &&
          typeof old.fullClaimSimulation === 'boolean',
      )
      const nativeNet = projectApyUsdNet(
        old.escrowRaw,
        Math.floor((src - oldCreated) / 1000),
        c.feeCurve,
      )
      check(nativeNet && nativeNet.netRaw === old.fullNetEaRaw)
      const status =
        old.claimSimulationStatus === undefined
          ? old.fullClaimSimulation
            ? 'succeeded'
            : 'unexplained_revert'
          : old.claimSimulationStatus
      check(
        status === 'succeeded' || status === 'native_time_gate' || status === 'unexplained_revert',
      )
      if (status === 'succeeded')
        check(
          old.fullClaimSimulation && (oldEscrow === 0n || src >= oldOpening) && !c.receiptPaused,
        )
      if (status === 'native_time_gate')
        check(!old.fullClaimSimulation && oldCreated > 0 && src < oldOpening && !c.receiptPaused)
      if (status === 'unexplained_revert') check(!old.fullClaimSimulation)
      return { old, oldEscrow, oldCreated, oldOpening, status }
    })
    // One shared native cash balance covers the total owned escrow; it is not reused per NFT.
    const sharedReservationQualified =
      receiptCash !== null && receiptCash >= ownedEscrow && !c.receiptPaused
    const H = q.horizonHours * 3600000,
      initiation = q.plannedInitiationOffsetSeconds * 1000,
      age = issue - src
    const mintTimestamp = Math.floor((issue + initiation) / 1000) * 1000
    const newOpeningOffset = mintTimestamp + c.feeCurve.minDurationSeconds * 1000 - issue
    const newMinimumFeeOffset = mintTimestamp + c.feeCurve.maxDurationSeconds * 1000 - issue
    const measure = (
      elapsed: number,
      period: number,
      dFunding: bigint,
      dGross: bigint,
    ): ApyUsdJointMeasurement => {
      const reasons: string[] = []
      let existingNet: bigint | null = 0n,
        newNet: bigint | null = 0n,
        frozen: bigint | null = null
      let state: ApyUsdJointMeasurement['initiation'] = 'not_yet_planned'
      const at = BigInt(age + Math.min(elapsed, initiation)),
        denominator = BigInt(period)
      const rawFunding = funding === null ? null : funding + floor(dFunding * at, denominator)
      const rawGross = gross + floor(dGross * at, denominator)
      const exhausted = rawFunding !== null && rawFunding <= 0n
      const quoteFloored = rawGross <= 0n
      if (!scopeComplete) reasons.push('owned_receipt_inventory_incomplete')
      let knownExisting = 0n
      const receiptDiagnostics = oldReceipts.map(
        ({ old, oldEscrow, oldCreated, oldOpening, status }) => {
          const eligible = !c.receiptPaused && issue + elapsed >= oldOpening
          const reserved =
            oldEscrow === 0n || (sharedReservationQualified && status !== 'unexplained_revert')
          let netRaw: string | null = '0'
          if (oldEscrow > 0n && !c.receiptPaused && !reserved) {
            netRaw = null
            existingNet = null
            reasons.push('existing_receipt_reservation_unqualified')
          } else if (oldEscrow > 0n && eligible) {
            const net = projectApyUsdNet(
              old.escrowRaw,
              Math.floor((issue + elapsed - oldCreated) / 1000),
              c.feeCurve,
            )
            check(net)
            const n = uint(net.netRaw)
            netRaw = n.toString()
            knownExisting += n
          }
          return { tokenId: old.tokenId, eligible, reservationQualified: reserved, netRaw }
        },
      )
      if (existingNet !== null) existingNet = knownExisting
      if (elapsed >= initiation && S > 0n) {
        state = 'not_initiated'
        if (!c.vaultPaused && !c.receiptPaused) {
          if (shareSimulationStatus === 'unexplained_revert') {
            state = 'censored'
            newNet = null
            reasons.push('full_share_initiation_unqualified')
          } else if (!feePolicyMatches) {
            state = 'censored'
            newNet = null
            reasons.push('current_preview_fee_policy_mismatch')
          } else if (funding === null) {
            state = 'censored'
            newNet = null
            reasons.push('current_native_vault_funding_unavailable')
          } else {
            // Source age appears once. Freeze only the escrow of this asset-denominated action.
            const projectedFunding = rawFunding! < 0n ? 0n : rawFunding!
            const projectedGross = rawGross < 0n ? 0n : rawGross
            const projectedEa = escrowFromGross(projectedGross)
            if (
              projectedFunding > MAX ||
              projectedEa > MAX ||
              projectedGross < projectedEa ||
              projectedGross > MAX
            ) {
              state = 'censored'
              newNet = null
              reasons.push('overflow_preinitiation_stock')
            } else if (!exhausted && !quoteFloored && projectedEa > 0n) {
              // E + ceil(E * fee / WAD) <= C iff E <= floor(C * WAD / (WAD + fee)).
              // withdrawForReceipt(E) avoids redeeming rounded-up shares for more than C.
              const fundedEscrow = (projectedFunding * WAD) / (WAD + vaultFee)
              const receiptCap = (1n << 208n) - 1n
              const fundedEntitlement = fundedEscrow < projectedEa ? fundedEscrow : projectedEa
              const capacityEscrow = fundedEntitlement < receiptCap ? fundedEntitlement : receiptCap
              if (capacityEscrow > 0n) {
                check(
                  requiredFunding(capacityEscrow) <= projectedFunding &&
                    requiredFunding(capacityEscrow) <= projectedGross,
                )
                state = 'hypothetically_funded'
                frozen = capacityEscrow
                // Custody moves once into a fully funded reservation; unrelated claims cannot spend it.
                if (elapsed >= newOpeningOffset) {
                  const net = projectApyUsdNet(
                    frozen.toString(),
                    Math.floor((issue + elapsed - mintTimestamp) / 1000),
                    c.feeCurve,
                  )
                  check(net)
                  newNet = uint(net.netRaw)
                }
              }
            }
          }
        }
      }
      const available = knownExisting + (newNet ?? 0n)
      if (available > MAX) reasons.push('combined_available_uint256_overflow')
      return {
        availableRaw: reasons.length ? null : available.toString(),
        headroomRaw: reasons.length ? null : (available - Q).toString(),
        knownFundedNetRaw: available > MAX ? null : available.toString(),
        vaultFundingExhausted: exhausted,
        grossQuoteFloored: quoteFloored,
        hypotheticalMintAtUtc: frozen === null ? null : new Date(mintTimestamp).toISOString(),
        existingNetRaw: existingNet?.toString() ?? null,
        receiptDiagnostics,
        newNetRaw: newNet?.toString() ?? null,
        frozenNewEscrowRaw: frozen?.toString() ?? null,
        initiation: state,
        censorReasons: reasons,
      }
    }
    check(Array.isArray(input.history) && input.history.length >= 2 && input.history.length <= 64)
    let previousTime = -1,
      previousBlock = -1
    const points = input.history.map((p) => {
      const at = source(p.source),
        acquired = clock(p.acquiredAtUtc)
      check(
        previousTime < at &&
          previousBlock < p.source.blockNumber &&
          at < src &&
          p.source.blockNumber < c.source.blockNumber &&
          at <= acquired &&
          acquired <= issue,
      )
      previousTime = at
      previousBlock = p.source.blockNumber
      check(
        p.owner === null &&
          p.historicalOwnership === false &&
          p.profileId === c.profileId &&
          p.runtimeRegime === c.runtimeRegime &&
          p.fullSharesRaw === c.fullSharesRaw &&
          p.assetDecimals === c.assetDecimals &&
          p.shareDecimals === c.shareDecimals,
      )
      const pc = nullable(p.vaultCashRaw),
        pv = nullable(p.vestedAmountRaw)
      nullable(p.receiptCashRaw)
      const pe = nullable(p.fullEscrowEaRaw),
        pg = nullable(p.fullGrossAssetsRaw)
      const policyMatches = pe === null || pg === null || pe === escrowFromGross(pg)
      const pf =
        pc === null || (basis === 'cash_plus_vested_assumption' && pv === null)
          ? null
          : pc + (basis === 'cash_plus_vested_assumption' ? pv! : 0n)
      check(pf === null || pf <= MAX)
      return { at, ea: pe, gross: pg, funding: pf, policyMatches }
    })
    const scenarios: ApyUsdJointScenario[] = [],
      excludedIntervals: { fromIndex: number; reason: string }[] = []
    for (let i = 0; i + 1 < points.length; i++) {
      const start = points[i],
        end = points[i + 1]
      if (!start.policyMatches || !end.policyMatches) {
        excludedIntervals.push({ fromIndex: i, reason: 'historical_preview_fee_policy_mismatch' })
        continue
      }
      if (
        start.funding === null ||
        end.funding === null ||
        start.ea === null ||
        end.ea === null ||
        start.gross === null ||
        end.gross === null
      ) {
        excludedIntervals.push({ fromIndex: i, reason: 'native_donor_stock_unavailable' })
        continue
      }
      const period = end.at - start.at,
        dc = end.funding - start.funding,
        de = end.ea - start.ea,
        dg = end.gross - start.gross
      const times = new Set<number>([0, H])
      for (let t = DAY; t < H; t += DAY) times.add(t)
      const oldBreakpoints = oldReceipts.flatMap((p) => [
        p.oldOpening - issue,
        p.oldCreated + c.feeCurve.maxDurationSeconds * 1000 - issue,
      ])
      for (const t of [initiation, newOpeningOffset, newMinimumFeeOffset, ...oldBreakpoints])
        if (t >= 0 && t <= H) {
          times.add(t)
          if (t > 0) times.add(t - 1)
        }
      const checkpoints = [...times]
        .sort((a, b) => a - b)
        .map((t) => ({
          elapsedMs: t,
          atUtc: new Date(issue + t).toISOString(),
          ...measure(t, period, dc, dg),
        }))
      const insuff =
        checkpoints.find((p) => !p.censorReasons.length && BigInt(p.headroomRaw!) < 0n)
          ?.elapsedMs ?? null
      const recovery =
        insuff === null
          ? null
          : (checkpoints.find(
              (p) =>
                p.elapsedMs > insuff && !p.censorReasons.length && BigInt(p.headroomRaw!) >= 0n,
            )?.elapsedMs ?? null)
      scenarios.push({
        fromIndex: i,
        donorPeriodMs: period,
        signedNetDelta: {
          vaultFundingRaw: dc.toString(),
          fullEscrowEaRaw: de.toString(),
          fullGrossAssetsRaw: dg.toString(),
        },
        target: measure(H, period, dc, dg),
        checkpoints,
        firstSampledInsufficiencyMs: insuff,
        firstSampledRecoveryMs: recovery,
        firstSampledVaultExhaustionMs:
          checkpoints.find((p) => p.vaultFundingExhausted)?.elapsedMs ?? null,
        unknownBetweenCheckpoints: true,
      })
    }
    const usable = scenarios.filter((s) => !s.target.censorReasons.length)
    const summary =
      usable.length === scenarios.length && scenarios.length > 0 && excludedIntervals.length === 0
        ? {
            available: distribution(usable.map((s) => BigInt(s.target.availableRaw!)))!,
            headroom: distribution(usable.map((s) => BigInt(s.target.headroomRaw!)))!,
          }
        : null
    return freeze({
      status: 'conditional_apy_usd_two_leg_joint_projection' as const,
      input,
      sourceAgeMs: age,
      targetAtUtc: new Date(issue + H).toISOString(),
      scenarios,
      excludedIntervals,
      targetSummary: summary,
      persistenceTarget: measure(H, 1, 0n, 0n),
      MRaw: null,
      assumptions: {
        fundingBasis: basis,
        vestedPullabilityAssumed: basis === 'cash_plus_vested_assumption',
        wholeReceiptClaimsOnly: true,
        reservedEscrowUnaffectedByOrdinaryOtherReceiptClaims: true,
        receiptCashHistoryDiagnosticOnly: true,
        initiationAtPlannedOffsetIsHypothetical: true,
        action: 'asset_denominated_withdrawForReceipt' as const,
        plannedEscrowStopsAccruingAfterInitiation: true,
        residualShareAccrualOutsidePlannedAction: true,
        receiptEscrowCapRaw: ((1n << 208n) - 1n).toString(),
        vaultFeeAlreadyIncludedInPreview: true,
        sourceAgeCountedOnce: true,
        competingNativeNetCountedOnce: true,
        requestedQCountedOnce: true,
        sampledDurationsRelativeToIssue: true,
        negativeFundingAndQuoteExtrapolationFlooredAtZero: true,
        hypotheticalMintTimestampFlooredToSeconds: true,
        miningTimeGuaranteed: false,
        stableRuntimeAndFeePolicyAssumed: true,
        primaryPreviewAndWithdrawalFeeSemanticsAssumed: true,
      },
      originalAuthority: false,
      authenticated: false,
      historicalOwnership: false,
      executionQualified: false,
      calibrated: false,
      sourceImplementationEquivalence: false,
      iidDonorsAssumed: false,
    })
  } catch {
    return null
  }
}

export type ApyUsdJointStockProjection = NonNullable<
  ReturnType<typeof buildApyUsdJointStockProjection>
>
