/**
 * Factual one-line copy for feed rows, and labels. Pure.
 *
 * Copy rules (owner spec 2026-10-05): say what the chain recorded — who, what, which
 * market, how much, when it becomes executable. No judgement words ("safe", "risky",
 * "healthy"), no predictions.
 */

import type { Entities, FeedAction } from './types'

const ZERO = '0x0000000000000000000000000000000000000000'
const WAD = 10n ** 18n

export const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** Plain number → "1.23M" style, 3 significant digits; small numbers keep 4 decimals max. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '∞'
  const a = Math.abs(n)
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [v, s] of units) if (a >= v) return `${Number((n / v).toPrecision(3))}${s}`
  if (a === 0) return '0'
  return a >= 1 ? `${Number(n.toPrecision(4))}` : `${Number(n.toPrecision(3))}`
}

export const usdText = (n: number | undefined): string => (n === undefined ? '' : `$${compact(n)}`)

/** Base units → whole-token float (display only). */
export const units = (base: string | bigint, decimals: number): number =>
  Number(BigInt(base)) / 10 ** decimals

export const symbolOf = (e: Entities, token: string | undefined): string => {
  if (!token || token === ZERO) return 'idle'
  return e.tokens[token.toLowerCase()]?.symbol ?? short(token)
}

export const pct = (x: number, dp = 1): string => `${(x * 100).toFixed(dp)}%`

/** LLTV WAD string → "86%". */
export const lltvText = (lltv: string): string => {
  const p = Number((BigInt(lltv) * 10_000n) / WAD) / 100
  return `${p}%`
}

export function marketLabel(e: Entities, id: string): string {
  const m = e.markets[id]
  if (!m) return `market ${short(id)}`
  if (m.collateral === ZERO) return `idle ${symbolOf(e, m.loan)}`
  return `${symbolOf(e, m.collateral)}/${symbolOf(e, m.loan)} (${lltvText(m.lltv)} LLTV)`
}

export function targetLabel(
  e: Entities,
  a: Pick<FeedAction, 'scope' | 'target' | 'protocol'>,
): string {
  const t = a.target
  if (!t) return ''
  switch (a.scope) {
    case 'market':
      if (a.protocol === 'morpho-v2') {
        const d = e.v2Ids[t]
        if (d?.market) return marketLabel(e, d.market)
      }
      return marketLabel(e, t)
    case 'strategy': {
      const s = e.strategies[t]
      return s ? `${s.name} (Euler strategy)` : `strategy ${short(t)}`
    }
    case 'collateral': {
      const d = e.v2Ids[t]
      return d?.collateral
        ? `all ${symbolOf(e, d.collateral)}-collateral markets`
        : `collateral cap ${short(t)}`
    }
    case 'adapter': {
      const d = e.v2Ids[t]
      return `adapter ${short(d?.adapter ?? t)}`
    }
    case 'reserve':
      return symbolOf(e, t)
    default:
      return short(t)
  }
}

export const vaultLabel = (e: Entities, vault: string): string =>
  e.vaults[vault]?.name ?? e.aaveMarkets[vault] ?? short(vault)

export function curatorLabel(e: Entities, vault: string): string {
  if (e.aaveMarkets[vault]) return e.aaveMarkets[vault]
  const k = e.vaults[vault]?.curatorKey
  return (k && e.curators[k]?.name) ?? (k ? short(k) : short(vault))
}

/** A cap value in words for this action's unit (vault asset, WAD %, or Aave whole tokens). */
export function capText(e: Entities, a: FeedAction, raw: string | undefined): string {
  if (raw === undefined) return '?'
  if (!/^\d+$/.test(raw)) return raw
  if (a.capType === 'relative') {
    const v = BigInt(raw)
    return v === WAD
      ? '100% (no relative cap)'
      : `${pct(Number((v * 1_000_000n) / WAD) / 1e6, 2)} of vault`
  }
  if (a.protocol === 'aave-v3') {
    const sym = symbolOf(e, a.target)
    return raw === '0' ? 'no cap' : `${compact(Number(raw))} ${sym}`
  }
  const asset = e.vaults[a.vault]?.asset
  const dec = asset ? (e.tokens[asset]?.decimals ?? 18) : 18
  const big = BigInt(raw)
  // Sentinels read as "unlimited": Vault V2 type(uint128).max, MetaMorpho type(uint184).max.
  if (big >= 2n ** 128n - 1n) return `unlimited ${symbolOf(e, asset)}`
  return `${compact(units(big, dec))} ${symbolOf(e, asset)}`
}

export const utc = (ts: number): string =>
  `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

export function durationText(s: number): string {
  if (s <= 0) return '0s'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** "; another rsETH market stays capped in this vault" / "; no other rsETH market capped in this vault". */
export function stillText(e: Entities, a: FeedAction): string {
  if (a.stillCapped === undefined || a.collateral.length !== 1) return ''
  const sym = symbolOf(e, a.collateral[0])
  return a.stillCapped
    ? `; another ${sym} market stays capped in this vault`
    : `; no other ${sym} market capped in this vault`
}

/** One factual sentence describing the action. */
export function actionText(e: Entities, a: FeedAction): string {
  const tgt = targetLabel(e, a)
  const cap = (x?: string) => capText(e, a, x)
  const capWord =
    a.capType === 'borrow'
      ? 'borrow cap'
      : a.capType === 'supply'
        ? 'supply cap'
        : a.capType === 'relative'
          ? 'relative cap'
          : a.capType === 'absolute'
            ? 'absolute cap'
            : 'supply cap'
  const fromTo = () => (a.from !== undefined ? `${cap(a.from)} → ${cap(a.to)}` : cap(a.to))
  const tl = (x?: string) =>
    x === undefined ? '?' : x === 'abdicated' ? 'abdicated' : durationText(Number(x))
  switch (a.kind) {
    case 'cap_submit':
      return `Submitted ${capWord} raise on ${tgt}: ${fromTo()}${a.validAt ? `; executable from ${utc(a.validAt)}` : ''}`
    case 'cap_raise':
      return `Raised ${capWord} on ${tgt}: ${fromTo()}`
    case 'cap_cut':
      return `Cut ${capWord} on ${tgt}: ${fromTo()}${a.note?.startsWith('direction inferred') ? ' (direction inferred from contract rules)' : ''}`
    case 'cap_zero':
      return `Set ${capWord} to 0 on ${tgt}${a.from !== undefined ? ` (was ${cap(a.from)})` : ''}${stillText(e, a)}`
    case 'cap_revoke':
      return `Revoked a pending ${capWord} change on ${tgt}${a.to !== undefined ? ` (to ${cap(a.to)})` : ''}`
    case 'removal_submit':
      return `Submitted forced removal of ${tgt}${a.validAt ? `; executable from ${utc(a.validAt)}` : ''}`
    case 'removal_revoke':
      return `Revoked the pending removal of ${tgt}`
    case 'market_removed':
      return `Removed ${tgt} from the withdraw queue${a.forced ? ' (after a submitted forced removal)' : ''}${stillText(e, a)}`
    case 'market_added':
      return `Added ${tgt} to the withdraw queue`
    case 'supply_queue_remove':
      return `Took ${tgt} out of the supply queue (new deposits no longer route there)`
    case 'supply_queue_add':
      return `Put ${tgt} in the supply queue`
    case 'timelock_submit':
      return `Submitted timelock change${a.note ? ` (${a.note})` : ''}: ${tl(a.from)} → ${tl(a.to)}${a.validAt ? `; executable from ${utc(a.validAt)}` : ''}`
    case 'timelock_set':
      return a.note
        ? `Timelock: ${a.note}${a.to && a.to !== 'abdicated' ? ` → ${tl(a.to)}` : ''}`
        : `Set timelock ${a.from !== undefined ? `${tl(a.from)} → ` : ''}${tl(a.to)}`
    case 'timelock_revoke':
      return 'Revoked a pending timelock change'
    case 'curator_set':
      return `Set curator to ${short(a.to ?? '')}`
    case 'allocator_set':
      return `${a.to === 'true' ? 'Added' : 'Removed'} allocator ${short(a.target ?? '')}`
    case 'guardian_submit':
      return `Submitted new guardian ${short(a.to ?? '')}${a.validAt ? `; executable from ${utc(a.validAt)}` : ''}`
    case 'guardian_set':
      return `Set guardian to ${short(a.to ?? '')}`
    case 'guardian_revoke':
      return 'Revoked a pending guardian change'
    case 'owner_set':
      return `Ownership ${a.from ? `${short(a.from)} → ` : 'to '}${short(a.to ?? '')}`
    case 'sentinel_set':
      return `${a.to === 'true' ? 'Added' : 'Removed'} sentinel ${short(a.target ?? '')}`
    case 'adapter_add':
      return `Added adapter ${short(a.target ?? '')}`
    case 'adapter_remove':
      return `Removed adapter ${short(a.target ?? '')}`
    case 'v2_submit':
      return `Submitted ${a.note ?? 'a timelocked change'}${a.validAt ? `; executable from ${utc(a.validAt)}` : ''}`
    case 'writeoff_submit':
      return `Submitted a write-off of the vault's ${tgt} position (adapter burnShares)${a.validAt ? `; executable from ${utc(a.validAt)}` : ''}`
    case 'writeoff':
      return `Wrote off the vault's ${tgt} position (adapter burnShares${a.assets ? `, ≈ ${capText(e, { ...a, capType: undefined }, a.assets)}` : ''})${stillText(e, a)}`
    case 'v2_revoke':
      return `Revoked pending ${a.note ?? 'change'}`
    case 'freeze':
      return `Froze the ${tgt} reserve (no new supply or borrow)`
    case 'unfreeze':
      return `Unfroze the ${tgt} reserve`
    case 'pause':
      return `Paused the ${tgt} reserve`
    case 'unpause':
      return `Unpaused the ${tgt} reserve`
    case 'borrow_off':
      return `Disabled borrowing of ${tgt}`
    case 'borrow_on':
      return `Enabled borrowing of ${tgt}`
    case 'ltv_zero':
      return `Set ${tgt} LTV to 0 (no new borrowing power from it)${a.note ? `; ${a.note.split(' · ')[1] ?? ''}` : ''}`
    case 'collateral_params':
      return `Changed ${tgt} collateral parameters: ${a.note ?? ''}`
  }
}
