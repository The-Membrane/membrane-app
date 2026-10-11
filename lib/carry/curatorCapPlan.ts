/** Fixed six-place display arithmetic only; never interpreted as on-chain token units. */
const DISPLAY_SCALE = 10n ** 6n
const MAX_DISPLAY_ASSET = 1_000_000_000_000n

export type CuratorVaultAsset = 'CDT' | 'USDC'

export type CapProposalState = 'not-submitted' | 'pending' | 'accepted' | 'revoked'

export type CuratorCapPlanInput = {
  asset: CuratorVaultAsset
  currentVenueAssets: string
  currentCap: string
  proposedCap: string
  targetVenueAssets: string
  matchingWithdrawal: string
  daysUntilNeeded: string
  proposalState: CapProposalState
  timelockDays: string
  pendingValidInDays: string
}

export type CuratorCapPlan = {
  /** For revoked state, this assumes a fresh submission today. */
  earliestCapEligibleInDays: number
  capShortfall: bigint
  matchingWithdrawalShortfall: bigint
  excessWithdrawal: bigint
  requiredSupply: bigint
  proposedHeadroom: bigint
  capStep: 'immediate' | 'timelocked'
  needsSubmission: boolean
  needsAcceptance: boolean
  readyByNeededDay: boolean
  structuralReady: boolean
  reason: 'ready' | 'cap' | 'withdrawal' | 'excess-withdrawal' | 'timing' | 'action'
}

/** A bounded display quantity, not a token-precision or transaction encoder. */
export function parseAssetDisplayUnits(value: string): bigint | null {
  const text = value.trim()
  const match = /^(\d{1,13})(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) return null
  const whole = BigInt(match[1])
  if (whole > MAX_DISPLAY_ASSET) return null
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'))
  const amount = whole * DISPLAY_SCALE + fraction
  return amount <= MAX_DISPLAY_ASSET * DISPLAY_SCALE ? amount : null
}

function parseDays(value: string, max: number): number | null {
  if (!/^\d{1,4}$/.test(value.trim())) return null
  const days = Number(value.trim())
  return Number.isSafeInteger(days) && days <= max ? days : null
}

const positiveDifference = (a: bigint, b: bigint) => (a > b ? a - b : 0n)

/**
 * Necessary conditions only for adding assets to one target venue in a net-zero
 * reallocation. The caller supplies every balance and action state. Venue
 * maxWithdraw, actual supply, idle balance, permissions, and code identity are
 * deliberately not inferred here.
 */
export function calculateCuratorCapPlan(input: CuratorCapPlanInput): CuratorCapPlan | null {
  if (input.asset !== 'CDT' && input.asset !== 'USDC') return null
  const currentVenueAssets = parseAssetDisplayUnits(input.currentVenueAssets)
  const currentCap = parseAssetDisplayUnits(input.currentCap)
  const proposedCap = parseAssetDisplayUnits(input.proposedCap)
  const targetVenueAssets = parseAssetDisplayUnits(input.targetVenueAssets)
  const matchingWithdrawal = parseAssetDisplayUnits(input.matchingWithdrawal)
  const daysUntilNeeded = parseDays(input.daysUntilNeeded, 3650)
  if (
    currentVenueAssets == null ||
    currentCap == null ||
    proposedCap == null ||
    targetVenueAssets == null ||
    matchingWithdrawal == null ||
    daysUntilNeeded == null ||
    targetVenueAssets <= currentVenueAssets ||
    (input.proposalState === 'accepted' && proposedCap !== currentCap)
  )
    return null

  const capStep = proposedCap <= currentCap ? 'immediate' : 'timelocked'
  if (
    !['not-submitted', 'pending', 'accepted', 'revoked'].includes(input.proposalState) ||
    (capStep === 'immediate' && ['pending', 'revoked'].includes(input.proposalState))
  )
    return null

  const timelockDays =
    capStep === 'timelocked' && ['not-submitted', 'revoked'].includes(input.proposalState)
      ? parseDays(input.timelockDays, 14)
      : 0
  const pendingValidInDays =
    capStep === 'timelocked' && input.proposalState === 'pending'
      ? parseDays(input.pendingValidInDays, 14)
      : 0
  if (
    timelockDays == null ||
    pendingValidInDays == null ||
    (capStep === 'timelocked' &&
      ['not-submitted', 'revoked'].includes(input.proposalState) &&
      timelockDays < 1)
  )
    return null

  const earliestCapEligibleInDays =
    input.proposalState === 'accepted' || capStep === 'immediate'
      ? 0
      : input.proposalState === 'pending'
        ? pendingValidInDays
        : timelockDays
  const requiredSupply = targetVenueAssets - currentVenueAssets
  const proposedHeadroom = positiveDifference(proposedCap, currentVenueAssets)
  const capShortfall = positiveDifference(targetVenueAssets, proposedCap)
  const matchingWithdrawalShortfall = positiveDifference(requiredSupply, matchingWithdrawal)
  const excessWithdrawal = positiveDifference(matchingWithdrawal, requiredSupply)
  const readyByNeededDay = earliestCapEligibleInDays <= daysUntilNeeded
  const needsSubmission =
    input.proposalState === 'not-submitted' || input.proposalState === 'revoked'
  const needsAcceptance = capStep === 'timelocked' && input.proposalState !== 'accepted'
  const structuralReady =
    capShortfall === 0n &&
    matchingWithdrawalShortfall === 0n &&
    excessWithdrawal === 0n &&
    readyByNeededDay &&
    input.proposalState === 'accepted'
  const reason =
    capShortfall > 0n
      ? 'cap'
      : matchingWithdrawalShortfall > 0n
        ? 'withdrawal'
        : excessWithdrawal > 0n
          ? 'excess-withdrawal'
          : !readyByNeededDay
            ? 'timing'
            : input.proposalState !== 'accepted'
              ? 'action'
              : 'ready'
  return {
    earliestCapEligibleInDays,
    capShortfall,
    matchingWithdrawalShortfall,
    excessWithdrawal,
    requiredSupply,
    proposedHeadroom,
    capStep,
    needsSubmission,
    needsAcceptance,
    readyByNeededDay,
    structuralReady,
    reason,
  }
}

export function formatAssetDisplayUnits(value: bigint, asset: CuratorVaultAsset): string {
  const whole = value / DISPLAY_SCALE
  const remainder = value % DISPLAY_SCALE
  const decimal =
    remainder === 0n ? '' : `.${remainder.toString().padStart(6, '0').replace(/0+$/, '')}`
  return `${new Intl.NumberFormat('en-US').format(whole)}${decimal} ${asset}`
}
