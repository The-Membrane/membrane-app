import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { COST_LEVELS_PCT } from './lib/depthCurve.mjs'
import {
  appendLocalVenueCurvePass,
  readLocalVenueCurvePasses,
} from './lib/localVenueCurveStore.mjs'
import { collectDepthCurveVenues, persistDepthCurvePass, readPass } from './record-depth-curves.mjs'

const config = JSON.parse(
  readFileSync(new URL('../tools/venue-recorder.config.json', import.meta.url)),
)
const venues = [config.venues.find((venue) => venue.name === 'scrvUSD')]
const hash = `0x${'a'.repeat(64)}`
const block = { number: 100n, hash, timestamp: 1790812800n }
const now = () => new Date(Number(block.timestamp) * 1000 + 60_000)
const points = COST_LEVELS_PCT.map((costPct, index) => ({ costPct, capacityUsd: index * 1000 }))
function client() {
  const calls = []
  return {
    calls,
    getChainId: async () => 1,
    getBlock: async (args) => {
      calls.push(args)
      return block
    },
  }
}
const read = (
  rpc = client(),
  readCurve = async () => ({ points, meta: { reserveUsd: 9_000_000 } }),
) => readPass(rpc, { venues, readNav: async () => 1, readCurve })

test('all market quote legs use one finalized block and hash confirmation before persistence', async () => {
  const rpc = client()
  const calls = []
  const pass = await read(rpc, async (received, venue, market, at) => {
    calls.push({ received, venue, market, at })
    return { points }
  })
  assert.equal(calls.length, venues[0].depthMarkets.filter((market) => market.enabled).length)
  assert.ok(calls.every((call) => call.received === rpc && call.at === block.number))
  assert.deepEqual(rpc.calls, [{ blockTag: 'finalized' }, { blockNumber: block.number }])
  assert.ok(pass.rows.every((row) => row.meta.sourceBlockHash === hash))
})

test('quote revert, partial/null level or changed hash cannot publish a pass', async () => {
  for (const result of [
    { error: 'quote_read_failed' },
    { points: points.slice(1) },
    {
      points: points.map((point, index) => (index === 3 ? { ...point, capacityUsd: null } : point)),
    },
  ])
    await assert.rejects(
      read(client(), async () => result),
      /incomplete_quote/,
    )
  const rpc = client()
  rpc.getBlock = async (args) => (args.blockTag ? block : { ...block, hash: `0x${'b'.repeat(64)}` })
  await assert.rejects(read(rpc), /source_hash_changed/)
})

test('local-only persistence needs no database and stores exact quoted level, never raw reserve', async () => {
  const root = mkdtempSync(join(tmpdir(), 'depth-pass-test-'))
  try {
    const pass = await read()
    const result = await persistDepthCurvePass(pass, {
      venues,
      now,
      append: (input) => appendLocalVenueCurvePass(input, { root, now, minFreeBytes: 0 }),
    })
    assert.equal(result.databaseUsed, false)
    assert.equal(result.status, 'local_curves_recorded')
    const saved = readLocalVenueCurvePasses('scrvUSD', { root }).records[0]
    assert.equal(saved.pass.block, '100')
    assert.ok(saved.pass.markets.every((market) => market.points[3].capacityUsd === 3000))
    assert.ok(saved.pass.markets.every((market) => !('reserveUsd' in market)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('all complete local venue passes seal before optional database writes and survive database failure', async () => {
  const order = []
  const pass = await read()
  await assert.rejects(
    persistDepthCurvePass(pass, {
      venues,
      now,
      append: async () => {
        order.push('local')
        return { status: 'appended' }
      },
      sql: async () => {
        order.push('database')
        throw Error('database unavailable')
      },
    }),
    /database unavailable/,
  )
  assert.deepEqual(order, ['local', 'database'])
})

test('incomplete configured market passes and changed config fail before the local sink', async () => {
  for (const mutate of [
    (pass) => pass.rows.pop(),
    (pass) => {
      pass.rows[0].meta.configIdentity = 'c'.repeat(64)
    },
    (pass) => {
      pass.rows[0].meta.sourceBlockHash = `0x${'b'.repeat(64)}`
    },
  ]) {
    const pass = await read()
    mutate(pass)
    let appends = 0
    await assert.rejects(
      persistDepthCurvePass(pass, {
        venues,
        now,
        append: async () => {
          appends++
          return { status: 'appended' }
        },
      }),
      /(local_curve_|depth_recorder_)/,
    )
    assert.equal(appends, 0)
  }
})

test('typed local file-cap stop prevents database write and is reported', async () => {
  let databaseCalls = 0
  await assert.rejects(
    persistDepthCurvePass(await read(), {
      venues,
      now,
      append: async () => ({ status: 'unavailable', reason: 'local_curve_file_limit' }),
      sql: async () => {
        databaseCalls++
      },
    }),
    /local_curve_file_limit/,
  )
  assert.equal(databaseCalls, 0)
})

test('one broken venue leaves a typed gap while another complete venue is recorded locally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'independent-depth-venues-'))
  const healthy = venues[0]
  const broken = config.venues.find((venue) => venue.name === 'sUSDS')
  try {
    const result = await collectDepthCurveVenues({
      venues: [broken, healthy],
      candidates: ['a', 'b'],
      clientFor: () => client(),
      read: (rpc, options) =>
        readPass(rpc, {
          ...options,
          readNav: async () => 1,
          readCurve: async (_rpc, venue) =>
            venue.name === broken.name ? { error: 'quote_reverted' } : { points },
        }),
      persist: (pass, options) =>
        persistDepthCurvePass(pass, {
          ...options,
          now,
          append: (input) => appendLocalVenueCurvePass(input, { root, now, minFreeBytes: 0 }),
        }),
    })
    assert.equal(result.status, 'partial')
    assert.equal(result.venues[0].status, 'unavailable')
    assert.equal(result.venues[0].attempts.length, 2)
    assert.equal(result.venues[1].status, 'recorded')
    assert.equal(readLocalVenueCurvePasses(broken.name, { root }).records.length, 0)
    assert.equal(readLocalVenueCurvePasses(healthy.name, { root }).records.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('per-venue fallback repeats every quote leg instead of splicing an earlier successful market', async () => {
  const calls = []
  const enabledMarkets = venues[0].depthMarkets.filter((market) => market.enabled)
  assert.ok(enabledMarkets.length > 1)
  const result = await collectDepthCurveVenues({
    venues,
    candidates: ['a', 'b'],
    clientFor: (host) => ({ ...client(), host }),
    read: (rpc, options) =>
      readPass(rpc, {
        ...options,
        readNav: async () => 1,
        readCurve: async (rpc, _venue, market) => {
          calls.push(`${rpc.host}:${market.name}`)
          return rpc.host === 'a' && market.name === enabledMarkets[1].name
            ? { error: 'quote_reverted' }
            : {
                points: points.map((point) => ({
                  ...point,
                  capacityUsd: point.capacityUsd * (rpc.host === 'b' ? 2 : 1),
                })),
              }
        },
      }),
    persist: async (pass) => {
      assert.ok(pass.rows.every((row) => row.points[3].capacityUsd === 6000))
    },
  })
  assert.equal(result.status, 'complete')
  assert.deepEqual(
    calls.filter((call) => call.startsWith('b:')),
    enabledMarkets.map((market) => `b:${market.name}`),
  )
})
