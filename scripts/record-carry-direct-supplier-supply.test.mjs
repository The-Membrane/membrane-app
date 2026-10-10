import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  freshSupplyFlowStart,
  MAX_SUPPLY_SEGMENTS_PER_MARKET_TICK,
  recordDirectSupplierSupplyTick,
  SUPPLY_MARKETS,
} from './record-carry-direct-supplier-supply.mjs'

const nowMs = 1_800_000_000_000
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const frozen = { targetBlock: 26089999, targetHash: hash(26089999), targetAtMs: nowMs - 600_000 }
const dir = () => mkdtempSync(join(tmpdir(), 'direct-supply-runner-'))
const spacious = () => ({ bavail: 3 * 1024 ** 3, bsize: 1 })
const urls = 'https://one.example/private-one,https://two.example/private-two'

function rpcFactory(atMs = nowMs) {
  return () => ({
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? 26090000 : Number(BigInt(params[0]))
        return {
          number: `0x${n.toString(16)}`,
          hash: hash(n),
          parentHash: hash(n - 1),
          timestamp: `0x${Math.floor((atMs - 600_000) / 1000).toString(16)}`,
        }
      }
      throw Error('unexpected_rpc')
    },
  })
}

test('each market gets a distinct fixed prospective anchor and never inherits USDC history', () => {
  const outDir = dir()
  try {
    for (const marketKey of SUPPLY_MARKETS) {
      const start = freshSupplyFlowStart({ marketKey, outDir, frozen, nowMs, stat: spacious })
      assert.deepEqual(start, { fromBlock: frozen.targetBlock, firstBlockHash: frozen.targetHash })
      const saved = JSON.parse(readFileSync(join(outDir, `supply-start-${marketKey}.json`), 'utf8'))
      assert.equal(saved.marketKey, marketKey)
      assert.equal(saved.fromBlock, frozen.targetBlock)
      assert.deepEqual(
        freshSupplyFlowStart({
          marketKey,
          outDir,
          frozen: { ...frozen, targetBlock: frozen.targetBlock + 100 },
          nowMs: nowMs + 20 * 60_000,
          stat: spacious,
        }),
        start,
      )
    }
    assert.equal(readdirSync(outDir).length, 4)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('anchor tampering and an unanchored segment fail closed', () => {
  const outDir = dir()
  try {
    const marketKey = 'aaveV3Usde'
    freshSupplyFlowStart({ marketKey, outDir, frozen, nowMs, stat: spacious })
    const path = join(outDir, `supply-start-${marketKey}.json`)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    saved.fromBlock = 26079847
    chmodSync(path, 0o644)
    writeFileSync(path, JSON.stringify(saved))
    assert.throws(
      () => freshSupplyFlowStart({ marketKey, outDir, frozen, nowMs, stat: spacious }),
      /invalid_direct_supply_anchor/,
    )
    rmSync(path)
    writeFileSync(join(outDir, `supply-${marketKey}-26079847-26079847.json`), '{}')
    assert.throws(
      () => freshSupplyFlowStart({ marketKey, outDir, frozen, nowMs, stat: spacious }),
      /unanchored_direct_supply_segments/,
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('disk reserve blocks enrollment before any anchor is written', () => {
  const outDir = dir()
  try {
    assert.throws(
      () =>
        freshSupplyFlowStart({
          marketKey: 'compoundV3Usdc',
          outDir,
          frozen,
          nowMs,
          stat: () => ({ bavail: 999_999_999, bsize: 1 }),
        }),
      /direct_supply_disk_reserve/,
    )
    assert.equal(readdirSync(outDir).length, 0)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('one market failure leaves the other three progressing with bounded supply-only calls', async () => {
  const outDir = dir()
  try {
    const calls = []
    const tick = await recordDirectSupplierSupplyTick({
      rpcUrls: urls,
      outDir,
      clientFactory: rpcFactory(),
      nowMs,
      stat: spacious,
      freshStart: ({ marketKey }) => ({
        fromBlock: marketKey === 'compoundV3Usdc' ? 26089999 : 26089998,
        firstBlockHash: hash(26089998),
      }),
      backfill: async (options) => {
        calls.push(options)
        if (options.marketKey === 'sparkLendUsdt') throw Error('https://private.example/secret')
        return {
          marketKey: options.marketKey,
          flowKind: 'supply',
          status: 'complete',
          throughBlock: frozen.targetBlock,
          newSegments: 1,
        }
      },
    })
    assert.equal(tick.results.length, 4)
    assert.equal(tick.results.filter((row) => row.status === 'failed').length, 1)
    assert.equal(calls.length, 4)
    assert.ok(
      calls.every(
        (call) =>
          call.flowKind === 'supply' && call.maxSegments === MAX_SUPPLY_SEGMENTS_PER_MARKET_TICK,
      ),
    )
    assert.equal(tick.results[2].marketKey, 'sparkLendUsdt')
    assert.equal(tick.results[3].marketKey, 'compoundV3Usdc')
    assert.equal(calls[3].fromBlock, 26089999)
    assert.equal(JSON.stringify(tick).includes('secret'), false)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('15-minute supply slots give every market the first turn without dropping failures', async () => {
  const outDir = dir()
  try {
    for (let slot = 0; slot < SUPPLY_MARKETS.length; slot++) {
      const tickMs = nowMs + slot * 15 * 60_000
      const calls = []
      const tick = await recordDirectSupplierSupplyTick({
        rpcUrls: urls,
        outDir,
        clientFactory: rpcFactory(tickMs),
        nowMs: tickMs,
        stat: spacious,
        freshStart: ({ marketKey }) => ({
          fromBlock: frozen.targetBlock,
          firstBlockHash: hash(frozen.targetBlock),
          marketKey,
        }),
        backfill: async (options) => {
          calls.push(options.marketKey)
          if (options.marketKey === 'sparkLendUsdt') throw Error('unavailable')
          return {
            marketKey: options.marketKey,
            flowKind: 'supply',
            status: 'complete',
            throughBlock: options.toBlock,
            newSegments: 1,
          }
        },
      })
      const expected = [...SUPPLY_MARKETS.slice(slot), ...SUPPLY_MARKETS.slice(0, slot)]
      assert.deepEqual(calls, expected)
      assert.deepEqual(
        tick.results.map((row) => row.marketKey),
        expected,
      )
      assert.deepEqual(new Set(calls), new Set(SUPPLY_MARKETS))
      assert.equal(tick.results.find((row) => row.marketKey === 'sparkLendUsdt').status, 'failed')
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('shell/plist schedule is bounded, locked, and distinct from withdrawal job', () => {
  const shell = fileURLToPath(new URL('./carry-direct-supplier-supply-tick.sh', import.meta.url))
  const plist = fileURLToPath(
    new URL('./launchd/com.membrane.carry-direct-supplier-supply.plist', import.meta.url),
  )
  assert.ok(existsSync(shell) && existsSync(plist))
  assert.equal(spawnSync('/bin/sh', ['-n', shell]).status, 0)
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plist]).status, 0)
  const script = readFileSync(shell, 'utf8')
  assert.match(script, /membrane-direct-supplier-supply\.lock/)
  assert.match(script, /240s/)
  assert.match(script, /record-carry-direct-supplier-supply\.mjs/)
  const config = readFileSync(plist, 'utf8')
  assert.match(config, /com\.membrane\.carry-direct-supplier-supply/)
  for (const minute of [7, 22, 37, 52])
    assert.match(config, new RegExp(`<integer>${minute}</integer>`))
  assert.doesNotMatch(config, /RunAtLoad<\/key>\s*<true\/>/)
})
