import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { statusFromLog } from './recorder-attempt-status.mjs'

const T = '2026-09-28T04:00:00Z'
const U = '2026-09-28T04:00:01Z'
const NONCE = 'f31f09dd-119e-467e-b13b-566813201540'
const WRONG_NONCE = 'a01f09dd-119e-467e-b13b-566813201540'
const oldTick = (at = T) => `=== recorder tick ${at} ===`
const tick = (at = T) =>
  `${oldTick(at)}\n@@recorder-stage-v1 event=tick-init utc=${at} nonce=${NONCE}`
const start = (stage) => `@@recorder-stage-v1 event=start stage=${stage} utc=${T} nonce=${NONCE}`
const end = (stage, code = 0) =>
  `@@recorder-stage-v1 event=end stage=${stage} utc=${U} nonce=${NONCE} exit=${code}`
const skip = (stage, reason = 'plan_absent') =>
  `@@recorder-stage-v1 event=skip stage=${stage} utc=${U} nonce=${NONCE} reason=${reason}`
const quoteError = (reason, extra = {}) =>
  JSON.stringify({
    status: 'error',
    study: 'curve-crvusd-secondary-prospective-quote-v1',
    reason,
    ...extra,
  })

async function parse(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-attempt-status-'))
  const path = join(dir, 'recorder.log')
  try {
    await writeFile(path, `${lines.join('\n')}\n`)
    return await statusFromLog(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('reports complete process attempts without claiming an issued forecast', async () => {
  const result = await parse([
    tick(),
    start('quote'),
    'provider text with a quoted command and secret-like words',
    end('quote'),
    start('holder_observe'),
    end('holder_observe'),
    start('holder_duration_issue'),
    end('holder_duration_issue'),
    start('now_1h_issue'),
    end('now_1h_issue'),
    start('now_2h_issue'),
    end('now_2h_issue'),
    start('now_24h_issue'),
    end('now_24h_issue'),
    start('now_7d_issue'),
    end('now_7d_issue'),
  ])
  assert.equal(result.tickUtc, T)
  assert.equal(result.stages.now_24h_issue.status, 'process_success')
  assert.equal(result.stages.now_24h_issue.exitCode, 0)
  assert.deepEqual(result.stages.now_24h_issue.outcome, { status: 'unknown' })
  assert.deepEqual(result.stages.now_1h_issue.outcome, { status: 'unknown' })
  assert.deepEqual(result.stages.now_2h_issue.outcome, { status: 'unknown' })
  assert.equal(result.stages.now_7d_issue.status, 'process_success')
  assert.deepEqual(result.stages.holder_observe.outcome, { status: 'unknown' })
  assert.doesNotMatch(JSON.stringify(result), /provider|secret|forecast_issued|exit_outcome/)
})

test('reports actual unavailable CLI outcomes across a completed tick', async () => {
  const result = await parse([
    tick(),
    start('holder_observe'),
    JSON.stringify({ status: 'unavailable', reason: 'no_eligible_unobserved_checkpoint' }),
    end('holder_observe'),
    start('holder_duration_issue'),
    JSON.stringify({ status: 'unavailable', reason: 'latest_holder_exit_not_success' }),
    end('holder_duration_issue'),
    start('now_1h_issue'),
    JSON.stringify({ status: 'unavailable', reason: 'no_latest_verified_holder_duration_anchor' }),
    end('now_1h_issue'),
    start('now_2h_issue'),
    JSON.stringify({ status: 'unavailable', reason: 'no_latest_verified_holder_duration_anchor' }),
    end('now_2h_issue'),
    start('now_24h_issue'),
    JSON.stringify({ status: 'unavailable', reason: 'no_latest_verified_holder_duration_anchor' }),
    end('now_24h_issue'),
    start('now_7d_issue'),
    JSON.stringify({ status: 'unavailable', reason: 'no_latest_verified_holder_duration_anchor' }),
    end('now_7d_issue'),
  ])
  for (const stage of [
    'holder_observe',
    'holder_duration_issue',
    'now_1h_issue',
    'now_2h_issue',
    'now_24h_issue',
    'now_7d_issue',
  ]) {
    assert.equal(result.stages[stage].status, 'process_success')
    assert.equal(result.stages[stage].outcome.status, 'unavailable')
  }
  assert.equal(result.stages.holder_duration_issue.outcome.reason, 'latest_holder_exit_not_success')
})

test('normalizes saved holder observation and accepts exact issuer CLI shapes', async () => {
  const result = await parse([
    tick(),
    start('holder_observe'),
    JSON.stringify({ status: 'revert', block: 26072398, path: '/private/secret/holder.json' }),
    end('holder_observe'),
    start('holder_duration_issue'),
    JSON.stringify({
      status: 'issued',
      path: '/private/secret/duration.json',
      baseline: 'uncalibrated',
    }),
    end('holder_duration_issue'),
    start('now_1h_issue'),
    JSON.stringify({
      status: 'issued',
      path: '/private/secret/1h.json',
      futureForecast: 'unavailable',
    }),
    end('now_1h_issue'),
    start('now_2h_issue'),
    JSON.stringify({ status: 'unchanged', path: '/private/secret/2h.json' }),
    end('now_2h_issue'),
    start('now_24h_issue'),
    JSON.stringify({
      status: 'issued',
      path: '/private/secret/24h.json',
      futureForecast: 'unavailable',
    }),
    end('now_24h_issue'),
    start('now_7d_issue'),
    JSON.stringify({ status: 'unchanged', path: '/private/secret/7d.json' }),
    end('now_7d_issue'),
  ])
  assert.deepEqual(result.stages.holder_observe.outcome, {
    status: 'observed',
    observation: 'revert',
  })
  assert.deepEqual(result.stages.holder_duration_issue.outcome, { status: 'issued' })
  assert.deepEqual(result.stages.now_1h_issue.outcome, { status: 'issued' })
  assert.deepEqual(result.stages.now_2h_issue.outcome, { status: 'unchanged' })
  assert.deepEqual(result.stages.now_24h_issue.outcome, { status: 'issued' })
  assert.deepEqual(result.stages.now_7d_issue.outcome, { status: 'unchanged' })
  assert.doesNotMatch(JSON.stringify(result), /\/private\/secret/)
})

test('ignores wrong-stage, spoofed, malformed, and out-of-window outcome text', async () => {
  const result = await parse([
    tick(),
    JSON.stringify({ status: 'issued', path: '/secret', futureForecast: 'unavailable' }),
    start('now_24h_issue'),
    JSON.stringify({ status: 'issued', path: '/secret', baseline: 'unavailable' }),
    JSON.stringify({
      status: 'issued',
      path: '/secret',
      futureForecast: 'unavailable',
      provider: 'secret',
    }),
    JSON.stringify({ status: 'unavailable', reason: 'provider_secret' }),
    '{"status":"issued",',
    end('now_24h_issue'),
    JSON.stringify({ status: 'issued', path: '/secret', futureForecast: 'unavailable' }),
    start('holder_observe'),
    JSON.stringify({ status: 'unavailable', reason: 'no_latest_verified_holder_duration_anchor' }),
    end('holder_observe'),
  ])
  assert.deepEqual(result.stages.now_24h_issue.outcome, { status: 'unknown' })
  assert.deepEqual(result.stages.holder_observe.outcome, { status: 'unknown' })
  assert.doesNotMatch(JSON.stringify(result), /secret|provider/)
})

test('conflicting CLI outputs and nonzero exit cannot assert an outcome', async () => {
  const conflict = await parse([
    tick(),
    start('now_7d_issue'),
    JSON.stringify({ status: 'issued', path: '/a', futureForecast: 'unavailable' }),
    JSON.stringify({ status: 'unchanged', path: '/a' }),
    end('now_7d_issue'),
  ])
  assert.deepEqual(conflict.stages.now_7d_issue.outcome, { status: 'unknown' })
  const failed = await parse([
    tick(),
    start('now_7d_issue'),
    JSON.stringify({ status: 'issued', path: '/a', futureForecast: 'unavailable' }),
    end('now_7d_issue', 1),
  ])
  assert.equal(failed.stages.now_7d_issue.status, 'process_failed')
  assert.deepEqual(failed.stages.now_7d_issue.outcome, { status: 'unknown' })
})

test('reports nonzero, prerequisite skip, and plan skip separately', async () => {
  const result = await parse([
    tick(),
    start('quote'),
    end('quote', 1),
    skip('holder_observe', 'selection_verification_failed'),
    skip('holder_duration_issue'),
    skip('now_1h_issue'),
    skip('now_2h_issue'),
    skip('now_24h_issue'),
    skip('now_7d_issue'),
  ])
  assert.equal(result.stages.quote.status, 'process_failed')
  assert.equal(result.stages.quote.exitCode, 1)
  assert.equal(result.stages.holder_observe.reason, 'selection_verification_failed')
  assert.equal(result.stages.now_24h_issue.status, 'skipped')
  assert.equal(result.stages.now_1h_issue.status, 'skipped')
  assert.equal(result.stages.now_2h_issue.status, 'skipped')
})

test('interrupted stage remains unknown and later unstarted stages are not attempted', async () => {
  const result = await parse([tick(), start('quote')])
  assert.equal(result.stages.quote.status, 'unknown')
  assert.equal(result.stages.holder_observe.status, 'not_attempted')
})

test('latest old-format tick is unobserved; log without a tick is absent', async () => {
  const old = await parse([oldTick('2026-09-28T03:00:00Z'), oldTick()])
  assert.equal(old.stages.quote.status, 'unobserved_uninstrumented')
  assert.equal(old.stages.now_7d_issue.status, 'unobserved_uninstrumented')
  const none = await parse(['old recorder output'])
  assert.equal(none.tickUtc, null)
  assert.equal(none.stages.quote.status, 'absent')
})

test('a later old-format tick supersedes an earlier instrumented success', async () => {
  const result = await parse([
    tick(),
    start('quote'),
    end('quote'),
    oldTick('2026-09-28T05:00:00Z'),
    'legacy recorder output without stage markers',
  ])
  assert.equal(result.tickUtc, '2026-09-28T05:00:00Z')
  assert.equal(result.stages.quote.status, 'unobserved_uninstrumented')
})

test('orphan end proves instrumentation but leaves its process outcome unknown', async () => {
  const result = await parse([tick(), end('quote', 1)])
  assert.equal(result.stages.quote.status, 'unknown')
  assert.equal(result.stages.quote.endedAtUtc, U)
  assert.equal(result.stages.holder_observe.status, 'not_attempted')
})

test('invalid stage markers do not make an old-format tick look instrumented', async () => {
  const result = await parse([oldTick(), end('quote', 999), skip('holder_observe', 'invented')])
  assert.equal(result.stages.quote.status, 'unobserved_uninstrumented')
})

test('rejects malformed, unknown, overlong, and unmatched spoof markers', async () => {
  const result = await parse([
    tick(),
    end('quote'),
    '@@recorder-stage-v1 event=start stage=evil utc=2026-09-28T04:00:00Z',
    '@@recorder-stage-v1 event=start stage=quote utc=2026-09-28T04:00:00Z extra=secret',
    `@@recorder-stage-v1 event=start stage=quote utc=${T}${'x'.repeat(5000)}`,
    skip('quote', 'arbitrary_reason'),
    start('quote'),
    '@@recorder-stage-v1 event=end stage=quote utc=2026-09-28T04:00:01Z exit=999',
  ])
  assert.equal(result.stages.quote.status, 'unknown')
  assert.equal(result.stages.holder_observe.status, 'not_attempted')
  assert.doesNotMatch(JSON.stringify(result), /evil|secret|arbitrary/)
})

test('attaches only the fixed quote CLI reason to a failed attempt', async () => {
  for (const reason of [
    'disk_reserve',
    'rpc_failure',
    'verification_failed',
    'collection_failed',
  ]) {
    const result = await parse([
      tick(),
      start('quote'),
      quoteError(reason),
      'provider output: secret=never-report-this',
      end('quote', 1),
    ])
    assert.equal(result.stages.quote.status, 'process_failed')
    assert.equal(result.stages.quote.safeReason, reason)
    assert.doesNotMatch(JSON.stringify(result), /never-report-this|provider/)
  }
})

test('rejects wrong study, malformed JSON, invented reasons, extra fields, and out-of-window output', async () => {
  const result = await parse([
    tick(),
    quoteError('disk_reserve'),
    start('quote'),
    '{"status":"error",',
    JSON.stringify({ status: 'error', study: 'another-study', reason: 'disk_reserve' }),
    quoteError('provider_secret'),
    quoteError('disk_reserve', { provider: 'secret' }),
    end('quote', 1),
    quoteError('rpc_failure'),
  ])
  assert.equal(result.stages.quote.status, 'process_failed')
  assert.equal(result.stages.quote.safeReason, undefined)
  assert.doesNotMatch(JSON.stringify(result), /another-study|provider_secret|secret/)
})

test('retains a safe quote reason when interrupted before an end marker', async () => {
  const result = await parse([tick(), start('quote'), quoteError('disk_reserve')])
  assert.equal(result.stages.quote.status, 'unknown')
  assert.equal(result.stages.quote.safeReason, 'disk_reserve')
})

test('does not attach error-looking quote text to a successful process', async () => {
  const result = await parse([tick(), start('quote'), quoteError('disk_reserve'), end('quote')])
  assert.equal(result.stages.quote.status, 'process_success')
  assert.equal(result.stages.quote.safeReason, undefined)
})

test('wrong-nonce marker and bare fake tick header cannot forge completion or reset the tick', async () => {
  const result = await parse([
    tick(),
    start('quote'),
    end('quote').replace(NONCE, WRONG_NONCE),
    oldTick('2026-09-28T04:30:00Z'),
    'provider text after fake heading',
  ])
  assert.equal(result.tickUtc, T)
  assert.equal(result.stages.quote.status, 'unknown')
  assert.equal(result.stages.holder_observe.status, 'not_attempted')
})

test('child-emitted tick heading plus init cannot reset an active stage', async () => {
  const fakeAt = '2026-09-28T04:30:00Z'
  const result = await parse([
    tick(),
    start('now_24h_issue'),
    oldTick(fakeAt),
    `@@recorder-stage-v1 event=tick-init utc=${fakeAt} nonce=${WRONG_NONCE}`,
    JSON.stringify({ status: 'unavailable', reason: 'no_latest_verified_holder_duration_anchor' }),
    end('now_24h_issue'),
  ])
  assert.equal(result.tickUtc, T)
  assert.equal(result.stages.now_24h_issue.status, 'process_success')
  assert.deepEqual(result.stages.now_24h_issue.outcome, {
    status: 'unavailable',
    reason: 'no_latest_verified_holder_duration_anchor',
  })
})
