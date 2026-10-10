import assert from 'node:assert/strict'
import test from 'node:test'
import { createMorphoHistoricalHolderEaCaptureControl } from '../../scripts/research/morpho-historical-holder-ea-capture-control.mjs'

function fixture() {
  let clock = 0
  const waits = []
  const control = createMorphoHistoricalHolderEaCaptureControl({
    monotonicNow: () => clock,
    wallNow: () => 1_000_000 + clock,
    pace: () => new Promise((resolve) => waits.push(resolve)),
  })
  return {
    control,
    waits,
    advance: (at) => {
      clock = at
    },
    tick: () => Promise.resolve(),
  }
}
const wire = { method: 'eth_call', params: [] }

test('closing an origin during pacing prevents late physical launches and drains its wrapper', async () => {
  const f = fixture(),
    scope = f.control.openWindow()
  let calls = 0,
    finished = false
  const work = f.control.request(
    'configured-host',
    wire,
    async () => {
      calls++
      return '0x1'
    },
    scope,
  )
  const rejected = assert.rejects(work, /capture_budget/)
  await f.tick()
  f.control.closeWindow(scope)
  const finish = f.control.finish().then((events) => {
    finished = true
    return events
  })
  await f.tick()
  assert.equal(finished, false)
  f.waits.shift()()
  await rejected
  assert.deepEqual(await finish, [])
  assert.equal(calls, 0)
})

test('expired origin windows prohibit physical launch even before a reader timeout callback', async () => {
  const f = fixture(),
    scope = f.control.openWindow()
  let calls = 0
  const work = f.control.request(
    'configured-host',
    wire,
    async () => {
      calls++
      return '0x1'
    },
    scope,
  )
  const rejected = assert.rejects(work, /capture_budget/)
  await f.tick()
  f.advance(12_000)
  f.waits.shift()()
  await rejected
  assert.deepEqual(await f.control.finish(), [])
  assert.equal(calls, 0)
})

test('global deadline is rechecked after pacing and remaining time bounds transport', async () => {
  const f = fixture()
  let timeout
  const work = f.control.request('configured-host', wire, async (_wire, ms) => {
    timeout = ms
    return '0x1'
  })
  await f.tick()
  f.advance(119_995)
  f.waits.shift()()
  assert.equal(await work, '0x1')
  assert.equal(timeout, 5)
  const late = f.control.request('configured-host', wire, async () => assert.fail('late launch'))
  const rejected = assert.rejects(late, /capture_budget/)
  await f.tick()
  f.advance(120_000)
  f.waits.shift()()
  await rejected
  const events = await f.control.finish()
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 'completed')
})

test('finish retains an already launched physical failure and disallows further work', async () => {
  const f = fixture()
  let failPhysical
  const work = f.control.request(
    'configured-host',
    wire,
    () =>
      new Promise((_resolve, reject) => {
        failPhysical = reject
      }),
  )
  const rejected = assert.rejects(work, /native_request_failed/)
  await f.tick()
  f.waits.shift()()
  await f.tick()
  const finish = f.control.finish()
  failPhysical(new Error('private transport details'))
  await rejected
  const events = await finish
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 'failed')
  assert.equal(events[0].error, 'native_request_failed')
  assert.ok(events[0].completedAtUtc)
  await assert.rejects(
    f.control.request('configured-host', wire, async () => assert.fail('after sealing')),
    /capture_budget/,
  )
})

test('origin windows independently restrict timeout and reject cloned scope tokens', async () => {
  const f = fixture(),
    scope = f.control.openWindow()
  await assert.rejects(
    f.control.request('configured-host', wire, async () => assert.fail('cloned scope'), {
      ...scope,
    }),
    /unknown_read_window/,
  )
  let timeout
  const work = f.control.request(
    'configured-host',
    wire,
    async (_wire, ms) => {
      timeout = ms
      return '0x1'
    },
    scope,
  )
  await f.tick()
  f.advance(11_990)
  f.waits.shift()()
  assert.equal(await work, '0x1')
  assert.equal(timeout, 10)
  f.control.closeWindow(scope)
  assert.equal((await f.control.finish()).length, 1)
})

for (const origin of [false, true]) {
  test(`late ${origin ? 'origin' : 'global'} success is retained but cannot be accepted`, async () => {
    const f = fixture(),
      scope = origin ? f.control.openWindow() : undefined
    let completePhysical
    const work = f.control.request(
      'configured-host',
      wire,
      () =>
        new Promise((resolve) => {
          completePhysical = resolve
        }),
      scope,
    )
    const rejected = assert.rejects(work, /capture_deadline/)
    await f.tick()
    f.waits.shift()()
    await f.tick()
    f.advance(origin ? 12_001 : 120_001)
    completePhysical('0xactual-result')
    await rejected
    const events = await f.control.finish()
    assert.equal(events.length, 1)
    assert.equal(events[0].status, 'completed')
    assert.equal(events[0].result, '0xactual-result')
    assert.equal(events[0].deadlineExceeded, true)
  })
}
