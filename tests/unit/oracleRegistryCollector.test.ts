// Oracle registry collector (scripts/oracle-registry): the pure read/decode helpers and the
// one property of the CLI that must hold even when it crashes — an RPC failure never prints
// the RPC URL (keyed endpoints carry the key in the URL path, which viem does not strip).

import { spawnSync } from 'child_process'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { getOracleCatalog } from '@/lib/oracleRegistry/catalog'
import {
  agesFromComponents,
  componentCalls,
  paramCalls,
} from '@/scripts/oracle-registry/lib/readers.mjs'

const COLLECT = join(process.cwd(), 'scripts', 'oracle-registry', 'collect.mjs')
const FAKE_KEY = 'FAKEKEY_cafebabe'

describe('collector CLI', () => {
  it('dies on an RPC error without printing the RPC URL or its key', () => {
    // A dead local port: connection refused, nothing leaves the machine, nothing is written
    // (the snapshot is written only after the head block and every read succeeded).
    const r = spawnSync(process.execPath, [COLLECT, '--snapshot-only'], {
      env: { ...process.env, ORACLE_REGISTRY_RPC_URL: `http://127.0.0.1:9/eth/${FAKE_KEY}` },
      encoding: 'utf8',
      timeout: 90_000,
    })
    const out = `${r.stdout}\n${r.stderr}`
    expect(r.status).toBe(1)
    expect(out).not.toContain(FAKE_KEY)
    expect(out).not.toContain('127.0.0.1:9')
    expect(r.stderr).toMatch(/oracle-registry collect failed/)
  }, 120_000)
})

describe('collector reads', () => {
  const catalog = getOracleCatalog()
  const byId = (id: string) => catalog.entries.find((e) => e.id === id)!

  it('reads the clocked feed behind a clockless input (nested `via` legs)', () => {
    const pt = byId('pt-srusde-22oct2026.aave.linear-discount')
    expect(componentCalls(pt).map((c: { address: string }) => c.address)).toContain(
      '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D',
    )
    // The nested leg's wiring getter is called on its parent component, not on the entry.
    const wiring = paramCalls(pt).find(
      (c: { tag: string }) => c.tag === 'component:ASSET_TO_USD_AGGREGATOR.ASSET_TO_USD_AGGREGATOR',
    )
    const parent = pt.mechanism.components.find((k) => k.role === 'ASSET_TO_USD_AGGREGATOR')!
    expect(wiring?.address).toBe(parent.address)
    const meta = byId('cbbtc.morpho.cbbtc-usdt-meta')
    expect(componentCalls(meta).map((c: { address: string }) => c.address)).toContain(
      '0x91D32e6f01d6473b596f54c6E304e06d774f86b2',
    )
  })

  it('reads leg ages for a median whose own timestamp is the read time', () => {
    const median = byId('eth.spark.eth-usd-median')
    expect(agesFromComponents(median)).toBe(true)
    expect(componentCalls(median).length).toBe(median.mechanism.components.length)
    expect(agesFromComponents(byId('eth.chainlink.eth-usd'))).toBe(false)
  })
})
