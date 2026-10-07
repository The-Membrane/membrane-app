/**
 * ERC-4626 share rate as a leaf.
 *
 * A vault whose totalAssets() tracks asset.balanceOf(this) has a share rate that moves
 * when assets arrive outside deposit(). Raising the rate by a factor e^x hands
 * (e^x − 1)·totalAssets to the existing holders, so C(x) = (e^x − 1)·TA. The move is
 * permanent and upward only. A vault with internal accounting does not move this way.
 *
 * Classification is a read-only heuristic, never a simulation:
 *  - 'balance-tracking': totalAssets() is within 0.5% of asset.balanceOf(vault).
 *  - 'internal': the two differ by more than 0.5% (assets deployed or accounted
 *    separately), so a transfer does not reach the rate directly.
 *  - 'unknown': either read failed.
 * 'balance-tracking' is a candidate only. README.md lists the vaults that need a
 * source review before a public card states the class as fact.
 */

import type { ImpactCurve, ImpactSample } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import { fn } from '../chain/abi'
import { xGrid } from './impact'

const BALANCE_OF = fn('balanceOf(address)', 'uint256')
const TOTAL_ASSETS = fn('totalAssets()', 'uint256')
const ASSET = fn('asset()', 'address')
const CONVERT_TO_ASSETS = fn('convertToAssets(uint256)', 'uint256')
const DECIMALS = fn('decimals()', 'uint8')

export type VaultClass = 'balance-tracking' | 'internal' | 'unknown'

export interface VaultInfo {
  vault: string
  asset: string | null
  assetDecimals: number
  shareDecimals: number
  totalAssets: bigint | null
  assetBalance: bigint | null
  /** Assets per whole share. */
  rate: number | null
  cls: VaultClass
}

export async function readVault(rpc: Rpc, vault: string, block: BlockTag): Promise<VaultInfo> {
  const [asset, ta, sd] = await rpc.multicall(
    [
      { target: vault, fn: ASSET },
      { target: vault, fn: TOTAL_ASSETS },
      { target: vault, fn: DECIMALS },
    ],
    block,
  )
  const shareDecimals = Number(sd ?? 18)
  let assetDecimals = 18
  let bal: bigint | null = null
  let rate: number | null = null
  if (asset) {
    const [ad, b, cta] = await rpc.multicall(
      [
        { target: asset, fn: DECIMALS },
        { target: asset, fn: BALANCE_OF, args: [vault] },
        { target: vault, fn: CONVERT_TO_ASSETS, args: [10n ** BigInt(shareDecimals)] },
      ],
      block,
    )
    assetDecimals = Number(ad ?? 18)
    bal = (b as bigint | null) ?? null
    rate = cta === null ? null : Number(cta) / Math.pow(10, assetDecimals)
  }
  let cls: VaultClass = 'unknown'
  if (ta !== null && bal !== null && ta > 0n) {
    const diff = Number(ta > bal ? ta - bal : bal - ta) / Number(ta)
    cls = diff <= 0.005 ? 'balance-tracking' : 'internal'
  }
  return { vault, asset: asset ?? null, assetDecimals, shareDecimals, totalAssets: ta ?? null, assetBalance: bal, rate, cls }
}

/** Upward-only cost curve for a balance-tracking vault: Q = J = (e^x − 1)·TA. */
export function donationCurve(totalAssetsUsd: number, note?: string): ImpactCurve {
  const samples: ImpactSample[] = xGrid('up').map((x) => {
    const q = Math.expm1(x) * totalAssetsUsd
    return { x, qUsd: q, jUsd: q }
  })
  return {
    direction: 'up',
    feeRate: 0,
    samples,
    maxX: Infinity,
    mechanism: 'donation',
    liquidity: 'full',
    note: note ?? 'ERC-4626 rate moved by an outside transfer (balance-tracking candidate)',
  }
}
