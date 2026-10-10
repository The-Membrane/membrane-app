import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  run,
  selectCases,
  verifyOffline,
  validateOutput,
} from './morpho-v2-route-panic-prestate.mjs'

const dir = new URL('../../data/research/venue-signals/', import.meta.url)
const positionPath = new URL('morpho-v2-route-panic-position.json', dir)
const baselinePath = new URL('morpho-v2-route-exit-baseline-first20.json', dir)
const position = JSON.parse(readFileSync(positionPath))
const baseline = JSON.parse(readFileSync(baselinePath))
const cases = selectCases(position, baseline)

test('frozen source selects exactly two B−1 cases and the old route', () => {
  assert.deepEqual(
    cases.map((x) => x.index),
    [15, 18],
  )
  for (const c of cases) {
    assert.equal(c.preBlock, c.routeBlock - 1)
    assert.notEqual(c.oldAdapter, c.newAdapter)
  }
  assert.throws(
    () =>
      selectCases(position, {
        ...baseline,
        results: baseline.results.map((x, i) =>
          i === 15 ? { ...x, route: cases[0].newAdapter } : x,
        ),
      }),
    /Frozen case linkage/,
  )
})

test('pinned B−1 RPC only; old route and both adapters are recorded', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'morpho-prestate-test-'))
  const out = join(outputDir, 'prestate.json')
  const calls = []
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockNumber }) => {
      calls.push({ kind: 'header', blockNumber })
      const c = cases.find((x) => BigInt(x.preBlock) === blockNumber)
      return { number: blockNumber, hash: c.preBlockHash }
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      calls.push({ kind: 'read', address, functionName, args, blockNumber })
      const c = cases.find((x) => BigInt(x.preBlock) === blockNumber)
      if (functionName === 'liquidityAdapter') return c.oldAdapter
      if (functionName === 'position')
        return [
          address === '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' && args[1] === c.oldAdapter
            ? 123n
            : 0n,
          0n,
          0n,
        ]
      if (functionName === 'supplyShares') {
        if (address === c.oldAdapter && c.index === 15) throw new Error('Old adapter has no getter')
        return address === c.oldAdapter ? 123n : 0n
      }
      throw new Error('Unexpected call')
    },
  }
  try {
    const saved = await run({ client, positionPath, baselinePath, out })
    assert.deepEqual(
      saved.results.map((x) => x.newPositionSupplyShares),
      ['0', '0'],
    )
    assert.deepEqual(
      saved.results.map((x) => x.oldTrackedSupplyShares),
      [null, '123'],
    )
    assert.equal(calls.length, 12)
    assert.ok(calls.every((x) => cases.some((c) => x.blockNumber === BigInt(c.preBlock))))
    assert.deepEqual(verifyOffline({ positionPath, baselinePath, out }), saved)
    assert.throws(
      () => validateOutput({ ...saved, results: saved.results.slice(1) }, cases),
      /checkpoint mismatch/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('wrong pinned header or selected route fail closed without output', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'morpho-prestate-fail-'))
  try {
    const base = {
      getChainId: async () => 1,
      getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: `0x${'0'.repeat(64)}` }),
    }
    await assert.rejects(
      run({ client: base, positionPath, baselinePath, out: join(outputDir, 'wrong-header.json') }),
      /header mismatch/,
    )
    const wrongRoute = {
      ...base,
      getBlock: async ({ blockNumber }) => ({
        number: blockNumber,
        hash: cases.find((x) => BigInt(x.preBlock) === blockNumber).preBlockHash,
      }),
      readContract: async () => cases[0].newAdapter,
    }
    await assert.rejects(
      run({
        client: wrongRoute,
        positionPath,
        baselinePath,
        out: join(outputDir, 'wrong-route.json'),
      }),
      /Old route not selected/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
