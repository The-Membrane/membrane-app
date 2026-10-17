import { describe, expect, it } from 'vitest'

import {
  exposureTargets,
  relationsOf,
  relationTag,
  tieStyle,
  uncheckedMarkets,
  type ExposureReport,
  type Holding,
  type RelationContext,
  type RelationMarket,
} from '@/lib/exposure'

// lib/exposure/relations.ts: how the viewer is tied to each market. Pure.

const USER = '0x00000000000000000000000000000000000000a1'
const vault = (i: number) => `0x${i.toString(16).padStart(40, '0')}`
const market = (i: number) => `0x${i.toString(16).padStart(64, '0')}`
const SNAPSHOT_TS = 1_791_500_000 // the exposure read
const SNAPSHOT_DAY = new Date(SNAPSHOT_TS * 1000).toISOString().slice(0, 10)

// V1 = vault(1) (MetaMorpho), V2 = vault(2) (Vault V2), vault(3) MetaMorpho.
const CTX: RelationContext = {
  vaults: {
    [vault(1)]: {
      protocol: 'morpho-v1',
      name: 'Alpha USDC',
      curatorName: 'Gauntlet',
      usdPerAsset: 1e-6,
    },
    [vault(2)]: {
      protocol: 'morpho-v2',
      name: 'Beta USDC',
      curatorName: 'Steakhouse',
      usdPerAsset: 1e-6,
    },
    [vault(3)]: {
      protocol: 'morpho-v1',
      name: 'Gamma',
      curatorName: '0x12393ccf9553eb402ffeb43678565ea5727cecf6',
    },
  },
  snapshotTs: SNAPSHOT_TS,
  minUsd: 1,
}

// The exposure snapshot: which vaults supplied which market.
const M: RelationMarket[] = [
  {
    market: market(1),
    locked: false,
    vaults: [
      { vault: vault(1), vaultName: 'Alpha USDC', curatorName: 'Gauntlet', usd: 10_000_000 },
      { vault: vault(2), vaultName: 'Beta USDC', curatorName: 'Steakhouse', usd: 4_000_000 },
    ],
  },
  {
    market: market(2),
    locked: true,
    vaults: [
      { vault: vault(2), vaultName: 'Beta USDC', curatorName: 'Steakhouse', usd: 2_000_000 },
    ],
  },
  { market: market(3), locked: false, vaults: [] },
  {
    market: market(4),
    locked: false,
    vaults: [
      {
        vault: vault(3),
        vaultName: 'Gamma',
        curatorName: '0x12393ccf9553eb402ffeb43678565ea5727cecf6',
        usd: 1_000_000,
      },
    ],
  },
]

type V = Extract<Holding, { kind: 'vault' }>
const report = (
  vaults: V[],
  direct: Extract<Holding, { kind: 'market' }>[] = [],
): ExposureReport => ({
  address: USER,
  chainId: 1,
  block: 26_200_000n,
  ethCalls: 3,
  results: [
    {
      id: 'vault-shares',
      label: 'Vault shares',
      status: vaults.length ? 'ok' : 'empty',
      holdings: vaults,
      checked: [vault(1), vault(2), vault(3)],
      failed: [],
    },
    {
      id: 'morpho-blue',
      label: 'Morpho Blue positions',
      status: direct.length ? 'ok' : 'empty',
      holdings: direct,
      checked: M.map((m) => m.market),
      failed: [],
    },
  ],
})

/** 25 % of the vault (250k of 1M assets). */
const quarter = { shares: 1n, assets: 250_000n, totalAssets: 1_000_000n }

describe('targets', () => {
  it('every snapshot vault (not only the listed ones), the market ids, and the MetaMorpho vaults to read live', () => {
    expect(exposureTargets(M, CTX.vaults)).toEqual({
      vaults: [vault(1), vault(2), vault(3)],
      markets: [market(1), market(2), market(3), market(4)],
      liveQueue: [vault(1), vault(3)],
      usdPerAsset: { [vault(1)]: 1e-6, [vault(2)]: 1e-6 },
    })
  })
})

describe('vault ties: live where the market list was read, else "as of" the snapshot', () => {
  it('live: the vault’s markets now, not the snapshot’s (the stale-tie case)', () => {
    // The snapshot says Alpha supplies market(1). Now it supplies market(3) and market(4)
    // only: market(1) is not "yours" any more, market(3)/(4) are, though unlisted.
    const r = relationsOf(
      M,
      report([
        {
          kind: 'vault',
          vault: vault(1),
          ...quarter,
          supplies: [
            { market: market(3), supplyShares: 9n, supplyAssets: 8_000_000n },
            { market: market(4), supplyShares: 1n },
          ],
        },
      ]),
      undefined,
      CTX,
    )
    expect(r.has(market(1))).toBe(false)
    expect(r.get(market(3))).toEqual({
      kind: 'via-vault',
      roles: ['vault'],
      path: [vault(1)],
      vaultNames: ['Alpha USDC'],
      usd: 2, // 25 % × 8,000,000 base units × $0.000001
      vaultUsd: 8, // what the vault supplies there
      book: false,
    })
    expect(tieStyle(r.get(market(3))!)).toBe('live')
    expect(relationTag(r.get(market(3))!)).toBe('your vault Alpha USDC')
    // market() failed for market(4): live, unpriced, not dust.
    expect(r.get(market(4))).toMatchObject({ kind: 'via-vault', book: false })
    expect(r.get(market(4))!.usd).toBeUndefined()
    expect(r.get(market(4))!.asOf).toBeUndefined()
  })

  it('a vault read live that supplies nothing ties nothing', () => {
    const r = relationsOf(
      M,
      report([{ kind: 'vault', vault: vault(1), ...quarter, supplies: [] }]),
      undefined,
      CTX,
    )
    expect(r.size).toBe(0)
  })

  it('no live list (a Vault V2, or a failed live read): the snapshot tie, tagged as of its date', () => {
    const r = relationsOf(
      M,
      report([{ kind: 'vault', vault: vault(2), ...quarter }]),
      undefined,
      CTX,
    )
    expect(r.get(market(1))).toEqual({
      kind: 'via-vault',
      roles: ['vault'],
      path: [vault(2)],
      vaultNames: ['Beta USDC'],
      usd: 1_000_000, // 25 % × the $4M allocation
      vaultUsd: 4_000_000,
      book: false,
      asOf: SNAPSHOT_TS,
    })
    expect(r.get(market(2))).toMatchObject({ usd: 500_000, book: true, asOf: SNAPSHOT_TS })
    expect(tieStyle(r.get(market(1))!)).toBe('snapshot')
    expect(relationTag(r.get(market(1))!)).toBe(`your vault Beta USDC · as of ${SNAPSHOT_DAY}`)
  })

  it('a live tie anywhere makes the relation live; a direct position is live', () => {
    const r = relationsOf(
      M,
      report(
        [
          { kind: 'vault', vault: vault(2), ...quarter },
          {
            kind: 'vault',
            vault: vault(1),
            ...quarter,
            supplies: [{ market: market(1), supplyShares: 1n, supplyAssets: 4_000_000n }],
          },
        ],
        [{ kind: 'market', market: market(2), supplyShares: 9n, borrowShares: 0n, collateral: 0n }],
      ),
      undefined,
      CTX,
    )
    expect(r.get(market(1))).toMatchObject({ path: [vault(2), vault(1)], usd: 1_000_001 })
    expect(r.get(market(1))!.asOf).toBeUndefined()
    // Live overall; the Vault V2 part keeps its date.
    expect(r.get(market(1))!.snapshotVaults).toEqual({ count: 1, asOf: SNAPSHOT_TS })
    expect(relationTag(r.get(market(1))!)).toBe(`your 2 vaults (1 as of ${SNAPSHOT_DAY})`)
    // market(2): direct (live) and a snapshot vault tie; the relation is live, the vault
    // part dated.
    expect(r.get(market(2))).toMatchObject({ kind: 'direct', roles: ['supply', 'vault'] })
    expect(r.get(market(2))!.asOf).toBeUndefined()
    expect(relationTag(r.get(market(2))!)).toBe(
      `you supply · your vault Beta USDC (as of ${SNAPSHOT_DAY})`,
    )
  })

  it('a failed asset read leaves the $ undefined, never a partial sum', () => {
    const r = relationsOf(
      M,
      report([{ kind: 'vault', vault: vault(2), shares: 1n, assets: undefined, totalAssets: 1n }]),
      undefined,
      CTX,
    )
    expect(r.get(market(1))).toMatchObject({ kind: 'via-vault', asOf: SNAPSHOT_TS })
    expect(r.get(market(1))!.usd).toBeUndefined()
  })
})

describe('dust: the vaults supply under the minimum to the market', () => {
  const tiny = { shares: 1n, assets: 1n, totalAssets: 10_000_000n } // 1e-7 of the vault
  const whole = { shares: 1n, assets: 1_000_000n, totalAssets: 1_000_000n } // all of it

  it('a small depositor’s real tie is not dust (the vault supplies $4M there)', () => {
    const r = relationsOf(M, report([{ kind: 'vault', vault: vault(2), ...tiny }]), undefined, CTX)
    expect(r.get(market(1))).toMatchObject({ vaultUsd: 4_000_000, asOf: SNAPSHOT_TS })
    expect(r.get(market(1))!.dustBelow).toBeUndefined()
    expect(tieStyle(r.get(market(1))!)).toBe('snapshot')
    // The tag does not depend on, or reveal, the viewer's $0.40 share.
    expect(relationTag(r.get(market(1))!)).toBe(`your vault Beta USDC · as of ${SNAPSHOT_DAY}`)
  })

  it('the vault supplies under $1: dust, whatever the viewer’s share; a direct position never is', () => {
    for (const size of [tiny, whole]) {
      const r = relationsOf(
        M,
        report(
          [
            {
              kind: 'vault',
              vault: vault(1),
              ...size,
              // 500,000 base units × $0.000001 = $0.50 supplied by the vault.
              supplies: [{ market: market(3), supplyShares: 1n, supplyAssets: 500_000n }],
            },
          ],
          [
            {
              kind: 'market',
              market: market(4),
              supplyShares: 1n,
              borrowShares: 0n,
              collateral: 0n,
            },
          ],
        ),
        undefined,
        CTX,
      )
      expect(r.get(market(3))).toMatchObject({ vaultUsd: 0.5, dustBelow: 1 })
      expect(tieStyle(r.get(market(3))!)).toBe('dust')
      expect(relationTag(r.get(market(3))!)).toBe('your vault Alpha USDC · supplies under $1')
      expect(r.get(market(4))!.dustBelow).toBeUndefined()
    }
  })

  it('an unpriced vault supply is not dust', () => {
    const r = relationsOf(
      M,
      report([
        {
          kind: 'vault',
          vault: vault(1),
          ...whole,
          supplies: [{ market: market(3), supplyShares: 1n }],
        },
      ]),
      undefined,
      CTX,
    )
    expect(r.get(market(3))!.vaultUsd).toBeUndefined()
    expect(r.get(market(3))!.dustBelow).toBeUndefined()
  })
})

describe('curator ties: the snapshot’s, so always as of its date', () => {
  it('the curator’s vaults and allocations; the strongest kind wins', () => {
    const r = relationsOf(M, undefined, 'Gauntlet', CTX)
    expect([...r.keys()]).toEqual([market(1)])
    expect(r.get(market(1))).toMatchObject({
      kind: 'same-curator',
      roles: ['curator'],
      path: [vault(1)],
      curatorName: 'Gauntlet',
      usd: 10_000_000,
      asOf: SNAPSHOT_TS,
    })
    expect(relationTag(r.get(market(1))!)).toBe(`curated by Gauntlet · as of ${SNAPSHOT_DAY}`)
    const both = relationsOf(
      M,
      report([
        {
          kind: 'vault',
          vault: vault(1),
          ...quarter,
          supplies: [{ market: market(1), supplyShares: 1n, supplyAssets: 4_000_000n }],
        },
      ]),
      'Steakhouse',
      CTX,
    ).get(market(1))!
    expect(both).toMatchObject({ kind: 'via-vault', roles: ['vault', 'curator'], usd: 1 })
    expect(both.asOf).toBeUndefined()
    expect(relationTag(both)).toBe('your vault Alpha USDC · curated by Steakhouse')
    const anon = relationsOf(M, undefined, '0x12393ccf9553eb402ffeb43678565ea5727cecf6', CTX).get(
      market(4),
    )!
    expect(relationTag(anon)).toBe(`curated by 0x1239…ecf6 · as of ${SNAPSHOT_DAY}`)
  })

  it('borrow and collateral roles read as such', () => {
    const r = relationsOf(
      M,
      report(
        [],
        [
          { kind: 'market', market: market(4), supplyShares: 0n, borrowShares: 3n, collateral: 7n },
          { kind: 'market', market: market(3), supplyShares: 0n, borrowShares: 0n, collateral: 7n },
        ],
      ),
      undefined,
      CTX,
    )
    expect(relationTag(r.get(market(4))!)).toBe('you borrow')
    expect(relationTag(r.get(market(3))!)).toBe('your collateral')
  })
})

describe('unchecked: unknown, never "none"', () => {
  it('a failed read or a failed resolver', () => {
    const base = report([])
    expect(uncheckedMarkets(M, base)).toEqual([])
    expect(uncheckedMarkets(M, undefined)).toEqual([])
    const noBal = structuredClone(base)
    noBal.results[0].checked = [vault(1), vault(3)]
    expect(uncheckedMarkets(M, noBal)).toEqual([market(1), market(2)])
    const noPos = structuredClone(base)
    noPos.results[1].checked = [market(1), market(2), market(4)]
    expect(uncheckedMarkets(M, noPos)).toEqual([market(3)])
    const mbDown = structuredClone(base)
    mbDown.results[1] = { ...mbDown.results[1], status: 'error', checked: [] }
    expect(uncheckedMarkets(M, mbDown)).toEqual(M.map((m) => m.market))
    // The vault-share read down as a whole: any vault could supply any market now.
    const vsDown = structuredClone(base)
    vsDown.results[0] = { ...vsDown.results[0], status: 'error', checked: [] }
    expect(uncheckedMarkets(M, vsDown)).toEqual(M.map((m) => m.market))
  })
})
