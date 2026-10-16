/**
 * RELATIONS: how a viewer is tied to each market, from an ExposureReport (resolve.ts) and
 * a chosen curator. Pure.
 *
 *   direct        the address has a Morpho Blue position in the market (supply, borrow
 *                 or collateral), read on chain at the report's block: LIVE
 *   via-vault     the address holds shares in a vault (read on chain) that supplies the
 *                 market. LIVE when the vault's market list was read at the block
 *                 (MetaMorpho: withdrawQueue ∩ supplyShares > 0). Otherwise (a Vault V2,
 *                 a failed or skipped live read) the tie is the exposure snapshot's, and
 *                 the relation carries `asOf`, the snapshot's time.
 *   same-curator  the chosen curator runs a vault the exposure snapshot lists for the
 *                 market: always `asOf` the snapshot.
 * A tie from the snapshot is never presented as live: `asOf` is set whenever no live tie
 * (direct, or a live vault tie) backs the relation, and the tag says "as of <date>".
 *
 * A market carries its strongest kind (direct, then via-vault, then same-curator) and
 * every role that applies. `usd`:
 *   via-vault     the address's look-through part: convertToAssets(shares) / totalAssets()
 *                 × the vault's supply in the market (live: market() totals × the vault's
 *                 USD per asset at the exposure read; snapshot: the allocation's USD).
 *                 Undefined when a read or a price is missing. In a supply-locked market it
 *                 is book value (`book`), never live supply.
 *   same-curator  the curator's vaults' allocations at the exposure read.
 *   direct        undefined: no live loan-token price is read here.
 * `dustBelow`: the tie is via vaults only and its look-through $ is under the minimum
 * (EXPOSED_MIN_USD, the line under which a market counts as having no curated exposure);
 * callers keep it under the same fold.
 *
 * A market whose read failed, or that no resolver checked, is `unchecked`, never "none".
 */

import type { ExposureReport, ExposureTargets, Holding } from './resolve'

export type RelationKind = 'direct' | 'via-vault' | 'same-curator'
export type RelationRole = 'supply' | 'borrow' | 'collateral' | 'vault' | 'curator'

export interface Relation {
  kind: RelationKind
  roles: RelationRole[]
  /** 'morpho-blue' for a direct position, then the vault addresses (lowercase). */
  path: string[]
  vaultNames: string[]
  curatorName?: string
  usd?: number
  /** `usd` is book value: the market's supply is locked. */
  book: boolean
  /** The tie rests on the exposure snapshot only: its time (unix s). Absent = read live. */
  asOf?: number
  /** Set (to the minimum) when a vaults-only tie's look-through $ is under it. */
  dustBelow?: number
}

/** The slice of a market view (lib/curatorFeed/service.ts OracleGapMarketView) used here. */
export interface RelationMarket {
  market: string
  locked: boolean
  vaults: { vault: string; vaultName: string; curatorName: string; usd?: number }[]
}

/** The slice of OracleGapResponse['vaults'] used here: every vault of the snapshot. */
export interface RelationVault {
  protocol: string
  name: string
  curatorName: string
  /** USD per base unit of the vault's asset at the exposure read. */
  usdPerAsset?: number
}

export interface RelationContext {
  /** Vaults by lowercase address (OracleGapResponse.vaults). */
  vaults: Readonly<Record<string, RelationVault>>
  /** The exposure snapshot's time (OracleGapResponse.meta.exposureTs). */
  snapshotTs: number
  /** OracleGapResponse.exposedMinUsd. */
  minUsd: number
}

/**
 * What to read for these markets: every vault of the snapshot (a vault can supply a
 * listed market now that the snapshot did not list), the market ids, and the MetaMorpho
 * vaults whose market list can be read live.
 */
export function exposureTargets(
  markets: readonly RelationMarket[],
  vaults: Readonly<Record<string, RelationVault>> = {},
): Required<ExposureTargets> {
  const all = new Set([
    ...Object.keys(vaults).map((v) => v.toLowerCase()),
    ...markets.flatMap((m) => m.vaults.map((v) => v.vault.toLowerCase())),
  ])
  return {
    vaults: [...all],
    markets: [...new Set(markets.map((m) => m.market.toLowerCase()))],
    liveQueue: Object.entries(vaults)
      .filter(([, v]) => v.protocol === 'morpho-v1')
      .map(([a]) => a.toLowerCase()),
  }
}

/** Curator names across the markets' vaults, named ones first, then addresses. */
export function curatorsOf(markets: readonly RelationMarket[]): string[] {
  const names = [...new Set(markets.flatMap((m) => m.vaults.map((v) => v.curatorName)))]
  const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)
  return names.sort(
    (a, b) =>
      Number(isAddr(a)) - Number(isAddr(b)) || a.localeCompare(b, 'en', { sensitivity: 'base' }),
  )
}

const KIND_ORDER: RelationKind[] = ['direct', 'via-vault', 'same-curator']

type VaultHolding = Extract<Holding, { kind: 'vault' }>

export function relationsOf(
  markets: readonly RelationMarket[],
  report: ExposureReport | undefined,
  curator: string | undefined,
  ctx: RelationContext,
): Map<string, Relation> {
  const held: VaultHolding[] = []
  const direct = new Map<string, Extract<Holding, { kind: 'market' }>>()
  for (const r of report?.results ?? [])
    for (const h of r.holdings)
      if (h.kind === 'vault') held.push(h)
      else direct.set(h.market, h)

  const out = new Map<string, Relation>()
  for (const m of markets) {
    const id = m.market.toLowerCase()
    const roles: RelationRole[] = []
    const kinds: RelationKind[] = []
    const path: string[] = []
    const vaultNames: string[] = []
    let usd: number | undefined
    let live = false
    const p = direct.get(id)
    if (p) {
      live = true
      kinds.push('direct')
      path.push('morpho-blue')
      if (p.supplyShares > 0n) roles.push('supply')
      if (p.borrowShares > 0n) roles.push('borrow')
      if (p.collateral > 0n) roles.push('collateral')
    }
    // Vault ties: the live market list where it was read, else the snapshot's.
    const ties: { vault: string; name: string; live: boolean; usd?: number }[] = []
    for (const h of held) {
      const frac =
        h.assets !== undefined && h.totalAssets !== undefined
          ? h.totalAssets > 0n
            ? ratio(h.assets, h.totalAssets)
            : 0
          : undefined
      const info = ctx.vaults[h.vault]
      if (h.supplies) {
        const s = h.supplies.find((x) => x.market === id)
        if (!s) continue
        const value =
          frac !== undefined && s.supplyAssets !== undefined && info?.usdPerAsset !== undefined
            ? frac * Number(s.supplyAssets) * info.usdPerAsset
            : undefined
        ties.push({ vault: h.vault, name: info?.name ?? h.vault, live: true, usd: value })
      } else {
        const v = m.vaults.find((x) => x.vault.toLowerCase() === h.vault)
        if (!v) continue
        ties.push({
          vault: h.vault,
          name: v.vaultName,
          live: false,
          usd: frac !== undefined && v.usd !== undefined ? frac * v.usd : undefined,
        })
      }
    }
    if (ties.length) {
      kinds.push('via-vault')
      roles.push('vault')
      for (const t of ties) {
        path.push(t.vault)
        vaultNames.push(t.name)
      }
      if (ties.some((t) => t.live)) live = true
      usd = ties.every((t) => t.usd !== undefined)
        ? ties.reduce((s, t) => s + (t.usd ?? 0), 0)
        : undefined
    }
    const curated = curator ? m.vaults.filter((v) => v.curatorName === curator) : []
    if (curated.length) {
      kinds.push('same-curator')
      roles.push('curator')
      if (!ties.length) {
        for (const v of curated) path.push(v.vault.toLowerCase())
        vaultNames.push(...curated.map((v) => v.vaultName))
        usd = curated.every((v) => v.usd !== undefined)
          ? curated.reduce((s, v) => s + (v.usd ?? 0), 0)
          : undefined
      }
    }
    if (!kinds.length) continue
    const kind = KIND_ORDER.find((k) => kinds.includes(k))!
    const dust = !p && !curated.length && usd !== undefined && usd < ctx.minUsd
    out.set(id, {
      kind,
      roles,
      path,
      vaultNames,
      ...(curated.length ? { curatorName: curator } : {}),
      ...(kind === 'direct' ? {} : usd !== undefined ? { usd } : {}),
      book: m.locked,
      ...(live ? {} : { asOf: ctx.snapshotTs }),
      ...(dust ? { dustBelow: ctx.minUsd } : {}),
    })
  }
  return out
}

/** Each market with its relation attached (`relation` absent: no tie found or checked). */
export function withRelations<T extends RelationMarket>(
  markets: readonly T[],
  relations: ReadonlyMap<string, Relation>,
): (T & { relation?: Relation })[] {
  return markets.map((m) => {
    const relation = relations.get(m.market.toLowerCase())
    return relation ? { ...m, relation } : m
  })
}

/** assets / total as a float, exact enough for a display share (both bigint). */
function ratio(assets: bigint, total: bigint): number {
  const SCALE = 10n ** 12n
  return Number((assets * SCALE) / total) / 1e12
}

/**
 * Markets whose tie to the address is unknown: the Morpho Blue read of the market failed
 * or was not made; the vault-share read failed as a whole (any vault could supply any
 * market now); or the balanceOf of a vault the snapshot lists for the market failed.
 */
export function uncheckedMarkets(
  markets: readonly RelationMarket[],
  report: ExposureReport | undefined,
): string[] {
  if (!report) return []
  const checked = new Set<string>()
  const fully: Record<string, boolean> = {}
  for (const r of report.results) {
    fully[r.id] = r.status === 'ok' || r.status === 'empty'
    for (const c of r.checked) checked.add(`${r.id}:${c}`)
  }
  return markets
    .filter((m) => {
      const id = m.market.toLowerCase()
      if (!fully['morpho-blue'] || !checked.has(`morpho-blue:${id}`)) return true
      if (!fully['vault-shares']) return true
      return m.vaults.some((v) => !checked.has(`vault-shares:${v.vault.toLowerCase()}`))
    })
    .map((m) => m.market.toLowerCase())
}

/** An unnamed curator is its address: "0x1239…ecf6". */
export const shortName = (s: string): string =>
  /^0x[0-9a-fA-F]{40}$/.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s

/** How a tie is drawn: live (heavy frame), snapshot (as of a date, muted), dust (under the
 *  fold, muted). */
export type TieStyle = 'live' | 'snapshot' | 'dust'
export const tieStyle = (r: Relation): TieStyle =>
  r.dustBelow !== undefined ? 'dust' : r.asOf !== undefined ? 'snapshot' : 'live'

/**
 * The tag a related card carries: "you supply · your vault Beta USDC", "your vault Beta
 * USDC · as of 2026-10-11", "curated by Gauntlet · as of 2026-10-11", "… · under $1".
 */
export function relationTag(r: Relation): string {
  const parts: string[] = []
  if (r.roles.includes('supply')) parts.push('you supply')
  if (r.roles.includes('borrow')) parts.push('you borrow')
  else if (r.roles.includes('collateral')) parts.push('your collateral')
  if (r.roles.includes('vault'))
    parts.push(
      r.vaultNames.length === 1
        ? `your vault ${r.vaultNames[0]}`
        : `your ${r.vaultNames.length} vaults`,
    )
  if (r.roles.includes('curator') && r.curatorName)
    parts.push(`curated by ${shortName(r.curatorName)}`)
  if (r.asOf !== undefined)
    parts.push(`as of ${new Date(r.asOf * 1000).toISOString().slice(0, 10)}`)
  if (r.dustBelow !== undefined) parts.push(`under $${r.dustBelow}`)
  return parts.join(' · ')
}
