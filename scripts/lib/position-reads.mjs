// Per-address POSITION reader — the ONE place that turns (client, venues,
// address) into that address's live USD position per venue. Extracted from
// pages/api/_lib/radarReads.ts so the Carry Radar API (Next/TS) AND the
// standalone node scripts (discover-carry-strats.mjs, refresh-strat-positions.mjs)
// read positions IDENTICALLY, with no logic drift. Pure viem — NO fs / env / db /
// Next imports — so it is safe to import from both a webpack bundle and plain node.
//
// PROVENANCE DISCIPLINE (owner, docs/BRAND_CHARTS.md §4): every number here is a
// LIVE chain read (balanceOf → convertToAssets). The only assumption is
// $1/underlying for the three $-stable ERC4626 underlyings and the aToken —
// stated by the caller's provenance, never invented here.

import { getAddress } from 'viem'

const erc4626Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
]

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
]

/**
 * Live per-venue USD position for an address: balanceOf → convertToAssets, valued
 * at $1/underlying. Returns a Map<venueName, usd>. Two multicalls: balances for
 * every venue, then convertToAssets for the ERC4626 vaults with a non-zero share
 * balance (an aToken balance is ALREADY underlying units, so it is used directly).
 *
 * @param {import('viem').PublicClient} client  a client whose chain declares multicall3
 * @param {Array<{name:string,kind:string,address:string,decimals?:number}>} venues
 * @param {`0x${string}`} address
 * @returns {Promise<Map<string, number>>}
 */
export async function readUsdByVenue(client, venues, address) {
  // Batch 1: balanceOf(user) for every venue.
  const balances = await client.multicall({
    allowFailure: true,
    contracts: venues.map((v) => ({
      address: getAddress(v.address),
      abi: v.kind === 'atoken-liquidity' ? erc20Abi : erc4626Abi,
      functionName: 'balanceOf',
      args: [address],
    })),
  })

  // Batch 2: convertToAssets(shares) for the ERC4626 vaults with a non-zero share
  // balance (aToken balance is ALREADY underlying units).
  const need4626 = venues
    .map((v, i) => ({ v, i, bal: balances[i]?.status === 'success' ? balances[i].result : 0n }))
    .filter((x) => x.v.kind === 'erc4626-cooldown' && x.bal > 0n)

  const assetsResults =
    need4626.length > 0
      ? await client.multicall({
          allowFailure: true,
          contracts: need4626.map((x) => ({
            address: getAddress(x.v.address),
            abi: erc4626Abi,
            functionName: 'convertToAssets',
            args: [x.bal],
          })),
        })
      : []
  const assetsByIdx = new Map()
  need4626.forEach((x, k) => {
    if (assetsResults[k]?.status === 'success') assetsByIdx.set(x.i, assetsResults[k].result)
  })

  const usdByVenue = new Map()
  venues.forEach((v, i) => {
    const bal = balances[i]?.status === 'success' ? balances[i].result : 0n
    let underlyingRaw
    if (v.kind === 'atoken-liquidity') {
      underlyingRaw = bal // aToken balance is underlying units
    } else {
      underlyingRaw = assetsByIdx.get(i) ?? 0n // convertToAssets(shares)
    }
    const dec = v.decimals ?? 18
    usdByVenue.set(v.name, Number(underlyingRaw) / 10 ** dec)
  })
  return usdByVenue
}
