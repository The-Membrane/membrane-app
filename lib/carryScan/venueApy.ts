/**
 * THE VENUE APY OF A VAULT ROW, AVERAGED (owner ruling 1, 2026-10-11: "Vaults should average
 * the APYs with hoverable data to show data sources").
 *
 * A VAULT ROW is a MetaMorpho (v1), Morpho Vault V2 or any other ERC-4626 vault (Euler Earn,
 * Fluid fTokens, savings vaults) that is not priced on-chain. Direct lending reserves (Aave v3,
 * Spark, Euler EVK with a LinearKink IRM) stay priced on-chain through netBreakdown; LPs and
 * unresolved rows stay DeFiLlama's.
 *
 * THE RULE (VENUE_APY_RULE), like for like:
 *   base         B = mean of the base figures present:
 *                    DeFiLlama apyBase (else apy − apyReward, as columns.ts baseApy),
 *                    Morpho API netApyExcludingRewards (Morpho vaults only),
 *                    on-chain 7-day convertToAssets growth (finalists that verified).
 *   with rewards W = mean of one with-rewards figure per source:
 *                    DeFiLlama apy, Morpho API netApy, and for a source with no reward view
 *                    (the on-chain 7-day growth) its base figure + R̄, where
 *                    R̄ = mean of (with − base) over the sources that report both
 *                    (0 when none does).
 *                When every source has a base figure, W = B + R̄ exactly: the base average
 *                plus the average reward. With no reward view anywhere, W = B.
 *   missing      a source with no figure is left out of the mean, never read as 0, and is
 *                listed as missing; a read that failed is listed as failed, with its reason.
 *   at size      as before: figure × TVL/(TVL+size) (columns.ts reportedAtSize), unpriced above
 *                5% of TVL. (a) and (b) take the averaged figures, and the rank follows (a).
 *   disagreement the averaged figures of one basis spread more than 1pp (max − min).
 *
 * The scan averages twice: at S4 with DeFiLlama and Morpho (the screen), and at S6 again with
 * the on-chain 7-day figure once a finalist has verified. Every figure is a fraction per year.
 */

import { reportedAtSize } from './columns'
import {
  SCAN_SIZES_USD,
  sizeKeyOf,
  THRESHOLDS,
  type ApySource,
  type LlamaPool,
  type MorphoVaultInfo,
  type ScoutKind,
  type SizeKey,
  type Valued,
  type VenueApy,
} from './types'

export const VAULT_KINDS: readonly ScoutKind[] = ['metamorpho', 'morpho-vault-v2', 'erc4626']
export const isVaultKind = (k: ScoutKind | null | undefined): boolean =>
  !!k && VAULT_KINDS.includes(k)

export const VENUE_APY_RULE =
  'Vault APYs (MetaMorpho, Morpho Vault V2, other ERC-4626) are an average of their sources, like for like: base = mean of DeFiLlama apyBase, Morpho’s net APY without rewards and the on-chain 7-day share-price growth; with rewards = that base mean + the mean reward of the sources that report one (DeFiLlama apy − apyBase, Morpho netApy − its no-rewards figure). A missing source is left out, never counted as 0. At a size the average is × TVL/(TVL+size). Lending reserves are priced on-chain; every other row is DeFiLlama’s.'

export const AVERAGED_AT_SIZE_NOTE = 'averaged APY × TVL/(TVL+size)'

export const llamaPoolUrl = (uuid: string): string => `https://defillama.com/yields/pool/${uuid}`
export const morphoVaultUrl = (address: string): string =>
  `https://app.morpho.org/ethereum/vault/${address}`
export const etherscanUrl = (address: string): string => `https://etherscan.io/address/${address}`

const finite = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v)
const mean = (xs: readonly number[]): number | null =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null
const spreadOf = (xs: readonly number[]): number | null =>
  xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : null

/** A fraction as percentage points, 2 decimals; a value that rounds to zero is "0.00", never "-0.00". */
export const ppText = (v: number): string => {
  const t = (v * 100).toFixed(2)
  return Number(t) === 0 ? '0.00' : t
}

const MORPHO_KINDS: readonly ScoutKind[] = ['metamorpho', 'morpho-vault-v2']

/** DeFiLlama's two figures for a row, as fractions (base like columns.ts baseApy). */
export function llamaFigures(p: LlamaPool): { base: number | null; withRewards: number | null } {
  const withRewards = finite(p.apy) ? p.apy / 100 : null
  const base = finite(p.apyBase)
    ? Math.max(0, p.apyBase) / 100
    : finite(p.apy)
      ? Math.max(0, p.apy - Math.max(0, p.apyReward ?? 0)) / 100
      : null
  return { base, withRewards }
}

/** The on-chain 7-day source for a finalist: a figure, or why there is none. */
export type Onchain7d =
  | { value: number; asOf: number; address: string }
  | { error: string; asOf: number | null; address: string | null }

export interface VaultApyInput {
  pool: LlamaPool
  /** When DeFiLlama and Morpho were fetched (unix seconds). */
  fetchedAt: number
  /** The Morpho vault, for a Morpho vault row; null for any other vault. */
  morpho: MorphoVaultInfo | null
  /**
   * The row's vault kind and address, when known. A Morpho kind (MetaMorpho, Vault V2) with no
   * Morpho API entry lists Morpho's two figures as missing instead of leaving them out unseen.
   */
  kind?: ScoutKind | null
  address?: string | null
  /** Absent before S6 (the screen); present for a finalist. */
  onchain?: Onchain7d
}

/** The averaged venue APY of a vault row and every source behind it (the rule above). */
export function averagedVenueApy(x: VaultApyInput): VenueApy {
  const sources: ApySource[] = []
  const ll = llamaFigures(x.pool)
  const llUrl = llamaPoolUrl(x.pool.pool)
  const push = (s: Omit<ApySource, 'averaged' | 'status'> & { status?: ApySource['status'] }) =>
    sources.push({
      ...s,
      status: s.status ?? (s.value === null ? 'missing' : 'ok'),
      averaged: s.value !== null && (s.status ?? 'ok') === 'ok',
    })

  push({
    source: 'defillama',
    label: 'DeFiLlama apyBase',
    basis: 'base',
    value: ll.base,
    asOf: x.fetchedAt,
    url: llUrl,
  })
  push({
    source: 'defillama',
    label: 'DeFiLlama apy',
    basis: 'with-rewards',
    value: ll.withRewards,
    asOf: x.fetchedAt,
    url: llUrl,
  })
  if (x.morpho) {
    const url = morphoVaultUrl(x.morpho.address)
    push({
      source: 'morpho-api',
      label: 'Morpho API net APY, no rewards',
      basis: 'base',
      value: finite(x.morpho.netApyExcludingRewards) ? x.morpho.netApyExcludingRewards : null,
      asOf: x.fetchedAt,
      url,
    })
    push({
      source: 'morpho-api',
      label: 'Morpho API net APY',
      basis: 'with-rewards',
      value: finite(x.morpho.netApy) ? x.morpho.netApy : null,
      asOf: x.fetchedAt,
      url,
    })
  } else if (x.kind && MORPHO_KINDS.includes(x.kind)) {
    const url = x.address ? morphoVaultUrl(x.address) : null
    for (const basis of ['base', 'with-rewards'] as const)
      push({
        source: 'morpho-api',
        label: basis === 'base' ? 'Morpho API net APY, no rewards' : 'Morpho API net APY',
        basis,
        value: null,
        asOf: x.fetchedAt,
        url,
        note: 'no Morpho API entry for this vault',
      })
  }
  if (x.onchain) {
    const o = x.onchain
    if ('value' in o && finite(o.value)) {
      push({
        source: 'onchain-7d',
        label: 'On-chain 7-day share-price growth',
        basis: 'base',
        value: o.value,
        asOf: o.asOf,
        url: etherscanUrl(o.address),
      })
    } else {
      push({
        source: 'onchain-7d',
        label: 'On-chain 7-day share-price growth',
        basis: 'base',
        value: null,
        status: 'failed',
        asOf: o.asOf,
        url: o.address ? etherscanUrl(o.address) : null,
        note: 'error' in o ? o.error : 'no figure',
      })
    }
  }

  // Per source id: its base and with-rewards figures (averaged ones only).
  const bySource = new Map<string, { base: number | null; withRewards: number | null }>()
  for (const s of sources) {
    if (!s.averaged || s.value === null) continue
    const e = bySource.get(s.source) ?? { base: null, withRewards: null }
    if (s.basis === 'base') e.base = s.value
    else e.withRewards = s.value
    bySource.set(s.source, e)
  }
  const bases = [...bySource.values()].map((e) => e.base).filter(finite)
  const withs = [...bySource.values()].map((e) => e.withRewards).filter(finite)
  const rewards = [...bySource.values()]
    .filter((e) => finite(e.base) && finite(e.withRewards))
    .map((e) => (e.withRewards as number) - (e.base as number))
  const rBar = mean(rewards) ?? 0
  const B = mean(bases)
  // One with-rewards entry per source: its own view, else its base + the mean reward.
  const entries: number[] = []
  for (const e of bySource.values()) {
    if (finite(e.withRewards)) entries.push(e.withRewards)
    else if (finite(e.base)) entries.push(e.base + rBar)
  }
  const W = mean(entries)

  // A base-only source has no reward view of its own: say how it enters the with-rewards mean.
  for (const s of sources) {
    if (s.source !== 'onchain-7d' || !s.averaged) continue
    s.note = `enters “with rewards” as this + the mean reward (${ppText(rBar)}pp)`
  }

  return {
    method: 'average',
    base: B,
    withRewards: W,
    spread: { base: spreadOf(bases), withRewards: spreadOf(withs) },
    sources,
  }
}

/** A row priced from DeFiLlama only (LPs, unresolved rows): its two figures, both used. */
export function llamaVenueApy(p: LlamaPool, fetchedAt: number): VenueApy {
  const ll = llamaFigures(p)
  const url = llamaPoolUrl(p.pool)
  const src = (basis: ApySource['basis'], value: number | null, label: string): ApySource => ({
    source: 'defillama',
    label,
    basis,
    value,
    status: value === null ? 'missing' : 'ok',
    asOf: fetchedAt,
    url,
    averaged: value !== null,
  })
  return {
    method: 'defillama',
    base: ll.base,
    withRewards: ll.withRewards,
    spread: { base: null, withRewards: null },
    sources: [
      src('base', ll.base, 'DeFiLlama apyBase'),
      src('with-rewards', ll.withRewards, 'DeFiLlama apy'),
    ],
  }
}

/**
 * A lending reserve priced on-chain: the IRM figures at the default size are the ones used;
 * DeFiLlama's are listed for reference and not averaged in.
 */
export function onchainIrmVenueApy(
  p: LlamaPool,
  fetchedAt: number,
  irm: { base: number | null; withRewards: number | null; asOf: number; address: string },
): VenueApy {
  const ll = llamaVenueApy(p, fetchedAt)
  const url = etherscanUrl(irm.address)
  const irmSrc = (basis: ApySource['basis'], value: number | null): ApySource => ({
    source: 'onchain-irm',
    label: basis === 'base' ? 'On-chain IRM at $100K, no incentives' : 'On-chain IRM at $100K, net',
    basis,
    value,
    status: value === null ? 'failed' : 'ok',
    asOf: irm.asOf,
    url,
    averaged: value !== null,
    note: 'priced per size through netBreakdown',
  })
  return {
    method: 'onchain-irm',
    base: irm.base,
    withRewards: irm.withRewards,
    spread: { base: null, withRewards: null },
    sources: [
      irmSrc('base', irm.base),
      irmSrc('with-rewards', irm.withRewards),
      ...ll.sources.map((s) => ({
        ...s,
        averaged: false,
        note: 'reference only: a lending reserve is priced on-chain',
      })),
    ],
  }
}

/** The at-size columns of an averaged row: the same dilution as a DeFiLlama-only row. */
export function venueColumnsFromAverage(
  va: VenueApy,
  tvlUsd: number,
): { venueNet: Record<SizeKey, Valued>; venueNetBase: Record<SizeKey, Valued> } {
  const venueNet = {} as Record<SizeKey, Valued>
  const venueNetBase = {} as Record<SizeKey, Valued>
  const at = (v: number | null, size: number): Valued => {
    if (v === null) return { apy: null, apr: null, labelClass: 'projected', note: 'no source' }
    const r = reportedAtSize(v, tvlUsd, size)
    return r.apy === null ? r : { ...r, note: AVERAGED_AT_SIZE_NOTE }
  }
  for (const size of SCAN_SIZES_USD) {
    venueNet[sizeKeyOf(size)] = at(va.withRewards, size)
    venueNetBase[sizeKeyOf(size)] = at(va.base, size)
  }
  return { venueNet, venueNetBase }
}

/** True when the averaged figures of either basis spread more than the 1pp threshold. */
export const sourcesDisagree = (va: VenueApy): boolean =>
  va.method === 'average' &&
  [va.spread.base, va.spread.withRewards].some(
    (s) => s !== null && s * 100 > THRESHOLDS.sourceDisagreementPp,
  )

/** The averaged sources of a row (what the popover marks "averaged"). */
export const averagedSources = (va: VenueApy): ApySource[] => va.sources.filter((s) => s.averaged)
