import assert from 'node:assert/strict'
import test from 'node:test'
import { createUmbrellaGhoV2ScorerAdapter } from './carry-exit-v2-umbrella-gho-scorer.mjs'
import { createLocalCarryExitV2Adapters } from '../research/carry-local-exit-v2-tick.mjs'
const start = Date.parse('2026-10-07T00:00:00.000Z')
const context = {
  issue: {
    payload: { issueId: 'umbrella:q:2', baselineBlock: '400', baselineHash: `0x${'c'.repeat(64)}` },
  },
  due: { horizonH: 1, deadlineAtUtc: new Date(start + 600000).toISOString() },
  plan: { targetAtUtc: new Date(start + 1000).toISOString() },
  row: { assetsRaw: '2' },
}
function origin(
  url,
  { request = async () => '0x1', send = async () => ({ status: 'fixture' }) } = {},
) {
  return { url, provider: new URL(url).origin, request, send }
}
test('scorer shares the physical 256-start cap across selection, provider failover and replay', async () => {
  let physical = 0
  const bad = origin('https://bad.example', {
      request: async () => {
        physical++
        throw Error('offline')
      },
    }),
    good = origin('https://good.example', {
      request: async () => {
        physical++
        return '0x1'
      },
      send: async () => {
        physical++
        return {}
      },
    }),
    verify = origin('https://verify.example', {
      send: async () => {
        physical++
        return {}
      },
    })
  const adapter = createUmbrellaGhoV2ScorerAdapter({
    origins: [bad, good, verify],
    preferredSecondaryUrl: verify.url,
    now: () => new Date(start),
    select: async ({ request }) => {
      await request('eth_chainId', [])
      return {}
    },
    measure: async (input) => {
      assert.equal(input.primary.url, good.url)
      assert.equal(input.secondary.url, verify.url)
      try {
        for (let i = 0; i < 255; i++)
          await (i % 2 === 0 ? input.primary : input.secondary).request({})
      } catch {
        return { status: 'unavailable', reason: 'collection_failed' }
      }
      throw Error('must_not_reach')
    },
  })
  const target = await adapter.chooseTarget(context),
    result = await adapter.measure(context, target)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'umbrella_score_rpc_start_limit')
  assert.equal(physical, 256)
})
test('earlier caller deadline rejects late target completion before fallback or measurement', async () => {
  let time = start,
    physical = 0
  const client = origin('https://one.example', {
    request: async () => {
      physical++
      time += 1000
      return '0x1'
    },
  })
  const adapter = createUmbrellaGhoV2ScorerAdapter({
    origins: [client, origin('https://two.example')],
    now: () => new Date(time),
    deadlineMs: start + 500,
    select: async ({ request }) => {
      await request('eth_chainId', [])
      return {}
    },
  })
  await assert.rejects(adapter.chooseTarget(context), /umbrella_score_deadline_elapsed/)
  assert.equal(physical, 1)
})
test('native score adapter defaults to 90 seconds within the 120-second job stage', async () => {
  let time = start
  const primary = origin('https://one.example', {
      request: async () => {
        time += 91000
        return '0x1'
      },
    }),
    secondary = origin('https://two.example')
  const adapters = createLocalCarryExitV2Adapters({
    primary,
    secondary,
    now: () => new Date(time),
    select: async ({ request }) => {
      await request('eth_chainId', [])
      return {}
    },
  })
  await assert.rejects(
    adapters.umbrella_gho.chooseTarget(context),
    /umbrella_score_deadline_elapsed/,
  )
})
test('a late verified replay result is unavailable and never handed to the coordinator', async () => {
  let time = start
  const adapter = createUmbrellaGhoV2ScorerAdapter({
    origins: [origin('https://one.example'), origin('https://two.example')],
    now: () => new Date(time),
    deadlineMs: start + 500,
    select: async () => ({}),
    measure: async () => {
      time += 1000
      return { status: 'verified', callEvidenceDoc: {} }
    },
  })
  const target = await adapter.chooseTarget(context)
  assert.equal((await adapter.measure(context, target)).status, 'unavailable')
})

test('selector swallowing attempted start 257 cannot select an exhausted target', async () => {
  let physical = 0
  const adapter = createUmbrellaGhoV2ScorerAdapter({
    origins: [
      origin('https://one.example', {
        request: async () => {
          physical++
          return '0x1'
        },
      }),
      origin('https://two.example'),
    ],
    now: () => new Date(start),
    select: async ({ request }) => {
      try {
        for (let i = 0; i < 257; i++) await request('eth_chainId', [])
      } catch {}
      return {}
    },
  })
  await assert.rejects(adapter.chooseTarget(context), /umbrella_score_rpc_start_limit/)
  assert.equal(physical, 256)
})

test('selector swallowing a caller deadline cannot hand off a late target', async () => {
  let time = start,
    physical = 0
  const adapter = createUmbrellaGhoV2ScorerAdapter({
    origins: [
      origin('https://one.example', {
        request: async () => {
          physical++
          time += 1000
          return '0x1'
        },
      }),
      origin('https://two.example'),
    ],
    now: () => new Date(time),
    deadlineMs: start + 500,
    select: async ({ request }) => {
      try {
        await request('eth_chainId', [])
      } catch {}
      return {}
    },
  })
  await assert.rejects(adapter.chooseTarget(context), /umbrella_score_deadline_elapsed/)
  assert.equal(physical, 1)
})

test('verified final permitted score response 256 succeeds without a false cap reason', async () => {
  let physical = 0
  const client = origin('https://one.example', {
    request: async () => {
      physical++
      return '0x1'
    },
    send: async () => {
      physical++
      return {}
    },
  })
  const adapter = createUmbrellaGhoV2ScorerAdapter({
    origins: [client, origin('https://two.example')],
    now: () => new Date(start),
    select: async ({ request }) => {
      await request('eth_chainId', [])
      return {}
    },
    measure: async ({ send }) => {
      for (let i = 0; i < 255; i++) await send({})
      return { status: 'verified', callEvidenceDoc: {} }
    },
  })
  const target = await adapter.chooseTarget(context)
  assert.equal((await adapter.measure(context, target)).status, 'verified')
  assert.equal(physical, 256)
})

test('measurement swallowing an expired caller deadline retains the score deadline reason', async () => {
  let time = start
  const client = origin('https://one.example', {
    send: async () => {
      time += 1000
      return {}
    },
  })
  const adapter = createUmbrellaGhoV2ScorerAdapter({
    origins: [client, origin('https://two.example')],
    now: () => new Date(time),
    deadlineMs: start + 500,
    select: async () => ({}),
    measure: async ({ send }) => {
      try {
        await send({})
      } catch {}
      return { status: 'unavailable', reason: 'collection_failed' }
    },
  })
  const target = await adapter.chooseTarget(context)
  assert.equal((await adapter.measure(context, target)).reason, 'umbrella_score_deadline_elapsed')
})
