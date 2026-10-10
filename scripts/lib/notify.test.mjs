import assert from 'node:assert/strict'
import test from 'node:test'
import { formatAlarmLine, formatDigest, notify } from './notify.mjs'

test('terms-only page edit is a factual notice with unclassified exit impact', () => {
  const line = formatAlarmLine({
    venue: 'scrvUSD',
    kind: 'terms_page_notice',
    severity: 'notice',
    evidence: {
      count: 1,
      latest: { kind: 'terms_page_changed' },
      sourceUrl: 'https://example.org/terms',
    },
  })
  assert.match(line, /^\[NOTICE\] scrvUSD terms_page_notice:/)
  assert.match(line, /page text changed.*exit impact unclassified/)
  assert.match(line, /review https:\/\/example\.org\/terms/)
  assert.doesNotMatch(line, /gate moved/)
})

test('legacy terms-only gate row formats as notice if retried', () => {
  const line = formatAlarmLine({
    venue: 'sUSDe',
    kind: 'gate_change',
    severity: 'alarm',
    evidence: {
      count: 1,
      latest: { kind: 'terms_page_changed' },
      events: [{ kind: 'terms_page_changed' }],
    },
  })
  assert.match(line, /^\[NOTICE\]/)
  assert.match(line, /exit impact unclassified/)
  assert.doesNotMatch(line, /gate moved/)
})

test('partial legacy evidence cannot hide a possible real gate event', () => {
  const line = formatAlarmLine({
    venue: 'sUSDe',
    kind: 'gate_change',
    severity: 'alarm',
    evidence: {
      count: 2,
      latest: { kind: 'terms_page_changed' },
      events: [{ kind: 'terms_page_changed' }],
    },
  })
  assert.match(line, /^\[ALARM\]/)
  assert.match(line, /legacy evidence incomplete.*exit impact unclassified/)
  assert.doesNotMatch(line, /gate moved/)
})

test('digest heading distinguishes notices from other signals without sending', () => {
  const notice = {
    venue: 'sUSDe',
    kind: 'terms_page_notice',
    severity: 'notice',
    evidence: { count: 1 },
  }
  const gate = {
    venue: 'sUSDe',
    kind: 'gate_change',
    severity: 'alarm',
    evidence: {
      count: 1,
      latest: { kind: 'cooldown_duration_changed' },
      events: [{ kind: 'cooldown_duration_changed' }],
    },
  }
  assert.match(formatDigest([notice], '2026-09-27T00:00:00Z'), /^Membrane venue notices \(1\)/)
  assert.match(
    formatDigest([notice, gate], '2026-09-27T00:00:00Z'),
    /^Membrane venue signals \(2\)/,
  )
  assert.doesNotMatch(formatDigest([notice], '2026-09-27T00:00:00Z'), /venue alarms/)
})

test('configured Telegram failure stays visible despite local fallback, then succeeds on retry', async () => {
  const alarm = { venue: 'scrvUSD', kind: 'utilization', severity: 'watch', evidence: {} }
  const appends = []
  const responses = [
    { ok: false, status: 503 },
    { ok: true, status: 200, json: async () => ({ ok: true }) },
  ]
  const opts = {
    get: (key) =>
      ({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' })[key] ?? null,
    fetch: async () => responses.shift(),
    appendFile: async (path, content) => appends.push({ path, content }),
    displayNotification: async () => {},
  }
  const first = await notify([alarm], opts)
  assert.deepEqual(first.telegram, { configured: true, delivered: false })
  assert.equal(first.ok, true)
  assert.ok(first.channels.includes('logfile'))

  const second = await notify([alarm], opts)
  assert.deepEqual(second.telegram, { configured: true, delivered: true })
  assert.ok(second.channels.includes('telegram'))
  assert.equal(appends.length, 2, 'the local log may repeat while Telegram is retried')
})

test('Telegram API rejection does not count as delivery on HTTP 200', async () => {
  const result = await notify(
    [{ venue: 'scrvUSD', kind: 'utilization', severity: 'watch', evidence: {} }],
    {
      get: (key) =>
        ({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' })[key] ?? null,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }),
      appendFile: async () => {},
      displayNotification: async () => {},
    },
  )
  assert.deepEqual(result.telegram, { configured: true, delivered: false })
  assert.ok(result.channels.includes('logfile'))
})

test('stalled Telegram fetch times out below the delivery lease and remains retryable', async () => {
  const alarm = {
    venue: 'scrvUSD',
    kind: 'terms_page_notice',
    severity: 'notice',
    evidence: { count: 1 },
  }
  let attempts = 0
  const opts = {
    get: (key) =>
      ({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' })[key] ?? null,
    telegramTimeoutMs: 15,
    fetch: async (_url, request) => {
      attempts++
      if (attempts > 1) return { ok: true, status: 200, json: async () => ({ ok: true }) }
      assert.ok(request.signal)
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        }),
      )
    },
    appendFile: async () => {},
    displayNotification: async () => {},
  }
  const keepAlive = setTimeout(() => {}, 100)
  const first = await notify([alarm], opts)
  clearTimeout(keepAlive)
  assert.deepEqual(first.telegram, { configured: true, delivered: false })
  const second = await notify([alarm], opts)
  assert.deepEqual(second.telegram, { configured: true, delivered: true })
  assert.equal(attempts, 2)
})

test('without Telegram configuration a local delivery remains sufficient', async () => {
  const result = await notify(
    [{ venue: 'scrvUSD', kind: 'utilization', severity: 'watch', evidence: {} }],
    {
      get: () => null,
      fetch: async () => {
        throw new Error('Telegram must not be called')
      },
      appendFile: async () => {},
      displayNotification: async () => {},
    },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.telegram, { configured: false, delivered: false })
  assert.ok(result.channels.includes('logfile'))
})

test('token-only and chat-only Telegram configuration leave remote delivery pending', async () => {
  for (const credentials of [
    { TELEGRAM_BOT_TOKEN: 'test-token' },
    { TELEGRAM_CHAT_ID: 'test-chat' },
  ]) {
    let fetches = 0
    const result = await notify(
      [{ venue: 'scrvUSD', kind: 'utilization', severity: 'watch', evidence: {} }],
      {
        get: (key) => credentials[key] ?? null,
        fetch: async () => {
          fetches++
          throw new Error('incomplete configuration must not send')
        },
        appendFile: async () => {},
        displayNotification: async () => {},
      },
    )
    assert.equal(fetches, 0)
    assert.equal(result.ok, true, 'local fallback still works')
    assert.deepEqual(result.telegram, { configured: true, delivered: false })
    assert.ok(result.channels.includes('logfile'))
  }
})
