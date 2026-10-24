/**
 * Live wavefront engine — the readers produce the Oct 10 pull's records. A scripted chain answers
 * exactly the reads the pull recorded for 8 Aave V3 events (every chain, e-mode on three,
 * multi-collateral, one not liquidatable at N) and 7 Morpho Blue events (one not liquidatable at
 * N); the live AaveReader / MorphoReader must rebuild the same record (position, HF at N to the
 * wei, liquidatable flag, borrowed with accrual, LTV at N), and the census spec built from it
 * must equal the census spec built from the pull's own row.
 *
 * Fixture: tests/unit/fixtures/wavefront-live-reads.json (scripts/wavefront-live/make-fixture.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { aavePositionSpec, type AaveEventRecord } from '@/lib/wavefront/aave'
import { morphoPositionSpec, type MorphoEventRecord } from '@/lib/wavefront/morpho'
import {
  AaveReader,
  CHAIN_CONFIG,
  MorphoReader,
  morphoAtN,
  type AaveLiquidation,
  type ChainKey,
  type MorphoLiquidation,
} from '@/lib/wavefront/live'
import { FakeChain, type FakeChainSpec } from './wavefrontLiveFake'

const FIX = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/wavefront-live-reads.json'), 'utf8'),
) as { aave: Record<string, any>[]; morpho: Record<string, any>[] }

const empty = (chain: ChainKey, N: number, ts: number): FakeChainSpec => ({
  chain,
  ts: (n) => ts + (n - N),
  head: N + 100,
  reserves: [],
  tokens: {},
  users: [],
  markets: [],
  morphoPositions: [],
  logs: [],
})

describe('live engine: Aave reader = the pull', () => {
  it.each(FIX.aave.map((r) => [`${r.chain} ${r.tx_hash.slice(0, 10)} eMode ${r.eMode}`, r]))(
    '%s',
    async (_name, row) => {
      const N = row.block_number as number
      const spec = empty(row.chain, N, row.ts)
      const pos = row.position as Record<string, any>[]
      spec.reserves = pos.map((p) => ({
        address: p.asset,
        symbol: p.symbol,
        decimals: p.decimals,
        id: p.id,
        ltv: p.ltv,
        lt: p.lt,
        price: (b: number) => BigInt((b === N ? p.priceN : p.priceNm1) ?? 0),
      }))
      if (row.eMode) {
        const inCat = pos.filter((p) => p.eModeLt != null)
        spec.emode = [
          {
            id: row.eMode,
            // A user can sit in a category while holding none of its assets.
            lt: inCat[0]?.eModeLt ?? 9_300,
            bitmap: inCat.reduce((a, p) => a | (1n << BigInt(p.id)), 0n),
          },
        ]
      }
      const a = row.accountDataNm1
      spec.users = [
        {
          address: row.user,
          eMode: row.eMode,
          collateral: Object.fromEntries(pos.map((p) => [p.asset, BigInt(p.aTokenBalance)])),
          debt: Object.fromEntries(pos.map((p) => [p.asset, BigInt(p.variableDebt)])),
          stableDebt: Object.fromEntries(pos.map((p) => [p.asset, BigInt(p.stableDebt)])),
          usage: Object.fromEntries(pos.map((p) => [p.asset, p.usageAsCollateralEnabled])),
          userConfig: BigInt(row.userConfig),
          accountData: [
            a.totalCollateralBase,
            a.totalDebtBase,
            a.availableBorrowsBase,
            a.currentLiquidationThreshold,
            a.ltv,
            a.healthFactor,
          ].map((x: string) => BigInt(x)),
        },
      ]
      const fake = new FakeChain(spec)
      const cfg = CHAIN_CONFIG[row.chain as ChainKey]
      const reader = new AaveReader(fake, cfg, {
        provider: cfg.aaveProvider.toLowerCase(),
        pool: cfg.aavePool,
        oracle: cfg.aaveOracle,
        dataProvider: fake.dataProvider,
        marketId: 'Fake Core Market',
      })
      const ev: AaveLiquidation = {
        protocol: 'aave-v3',
        pool: CHAIN_CONFIG[row.chain as ChainKey].aavePool,
        chain: row.chain,
        block: N,
        blockHash: '',
        tx: row.tx_hash,
        logIndex: row.log_index,
        ts: row.ts,
        pid: `aave-v3:${row.chain}:${row.user}`,
        collateralAsset: row.collateral_asset,
        debtAsset: row.debt_asset,
        user: row.user,
        debtToCover: '0',
        liquidatedCollateralAmount: '0',
        liquidator: '0x0000000000000000000000000000000000000000',
        receiveAToken: false,
      }
      const got = await reader.read(ev)
      expect(got.hfExact).toBe(true)
      expect(got.record.eMode).toBe(row.eMode)
      expect(got.record.atN.healthFactor).toBe(row.atN.healthFactor)
      expect(got.record.atN.liquidatable).toBe(row.atN.liquidatable)
      expect(got.record.hfNm1).toBe(row.hfNm1)
      const keys = [
        'asset',
        'symbol',
        'id',
        'decimals',
        'aTokenBalance',
        'variableDebt',
        'stableDebt',
        'usageAsCollateralEnabled',
        'collateralFlag',
        'borrowingFlag',
        'ltv',
        'lt',
        'ltUsed',
        'priceNm1',
        'priceN',
      ]
      const pick = (p: Record<string, unknown>) => Object.fromEntries(keys.map((k) => [k, p[k]]))
      expect(got.record.position.map((p) => pick(p as unknown as Record<string, unknown>))).toEqual(
        pos.map(pick),
      )
      const opts = { startTs: 1760054400, stepSeconds: 60, debtMinimumUsd: 2000 }
      expect(aavePositionSpec([got.record], opts)).toEqual(
        aavePositionSpec([row as unknown as AaveEventRecord], opts),
      )
    },
  )
})

describe('live engine: Morpho reader = the pull', () => {
  it.each(FIX.morpho.map((r) => [`${r.chain} ${r.tx_hash.slice(0, 10)} liquidatable ${r.liquidatableN}`, r]))(
    '%s',
    async (_name, row) => {
      const m = row.marketNm1
      // The pure accrual + health check on the recorded inputs.
      const x = morphoAtN({
        borrowShares: BigInt(row.positionNm1.borrowShares),
        collateral: BigInt(row.positionNm1.collateral),
        totalBorrowAssets: BigInt(m.totalBorrowAssets),
        totalBorrowShares: BigInt(m.totalBorrowShares),
        lastUpdate: BigInt(m.lastUpdate),
        rate: BigInt(row.borrowRatePerSecNm1),
        tsN: row.tsHeaderN,
        priceN: row.priceN == null ? null : BigInt(row.priceN),
        lltv: BigInt(row.lltv),
      })
      expect(x.borrowedN.toString()).toBe(row.borrowedNAccrued)
      expect(x.liquidatableN).toBe(row.liquidatableN)
      expect(x.ltvN).toBe(row.ltvN)

      // The whole reader against a chain that answers the recorded reads.
      const N = row.block_number as number
      const spec = empty(row.chain, N, row.tsHeaderN)
      const irm = '0x00000000000000000000000000000000000001f1'
      spec.markets = [
        {
          id: row.market_id,
          loanToken: row.loanToken,
          collateralToken: row.collateralToken,
          oracle: row.oracle,
          irm,
          lltv: BigInt(row.lltv),
          totalBorrowAssets: BigInt(m.totalBorrowAssets),
          totalBorrowShares: BigInt(m.totalBorrowShares),
          lastUpdate: BigInt(m.lastUpdate),
          price: (b: number) => BigInt((b === N ? row.priceN : row.priceNm1) ?? 0),
          rate: BigInt(row.borrowRatePerSecNm1),
        },
      ]
      spec.tokens = {
        [row.loanToken]: { symbol: 'LOAN', decimals: row.loanDecimals },
        [row.collateralToken]: { symbol: 'COLL', decimals: row.collateralDecimals },
      }
      spec.morphoPositions = [
        {
          marketId: row.market_id,
          borrower: row.borrower,
          borrowShares: BigInt(row.positionNm1.borrowShares),
          collateral: BigInt(row.positionNm1.collateral),
        },
      ]
      const reader = new MorphoReader(new FakeChain(spec), CHAIN_CONFIG[row.chain as ChainKey])
      const ev: MorphoLiquidation = {
        protocol: 'morpho-blue',
        chain: row.chain,
        block: N,
        blockHash: '',
        tx: row.tx_hash,
        logIndex: row.log_index,
        ts: row.tsHeaderN,
        pid: `morpho-blue:${row.chain}:${row.market_id}:${row.borrower}`,
        marketId: row.market_id,
        caller: '0x0000000000000000000000000000000000000000',
        borrower: row.borrower,
        repaidAssets: '0',
        repaidShares: '0',
        seizedAssets: '0',
        badDebtAssets: '0',
        badDebtShares: '0',
      }
      const got = await reader.readOpen(ev)
      const fields = [
        'chain',
        'block_number',
        'log_index',
        'tx_hash',
        'borrower',
        'market_id',
        'oracle',
        'loanToken',
        'collateralToken',
        'loanDecimals',
        'collateralDecimals',
        'lltv',
        'positionNm1',
        'priceN',
        'borrowedNAccrued',
        'ltvN',
        'liquidatableN',
      ]
      const pick = (r: Record<string, unknown>) => Object.fromEntries(fields.map((k) => [k, r[k]]))
      expect(pick(got.record as unknown as Record<string, unknown>)).toEqual(pick(row))
      const opts = {
        startTs: 1760054400,
        stepSeconds: 60,
        debtMinimumUsd: 2000,
        collateralSymbol: 'COLL',
        loanSymbol: 'LOAN',
        loanUsd: () => 1,
      }
      expect(morphoPositionSpec([got.record], opts)).toEqual(
        morphoPositionSpec([{ ...row, ts: row.tsHeaderN } as unknown as MorphoEventRecord], opts),
      )
    },
  )
})
