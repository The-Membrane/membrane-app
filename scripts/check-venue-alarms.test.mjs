import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  evalDrawdown,
  evalGateChange,
  evalTermsPageNotice,
  isLegacyTermsOnlyGateAlarm,
  reconcileAlarms,
  termsNoticeRows,
  termsNoticeExpired,
} from './lib/alarmRules.mjs'

const checker = readFileSync(
  fileURLToPath(new URL('./check-venue-alarms.mjs', import.meta.url)),
  'utf8',
)

test('uncertified flow rows cannot activate flow alarms or notifications', () => {
  assert.doesNotMatch(checker, /FROM\s+venue_flows\b/i)
  assert.doesNotMatch(checker, /\bevalOutflowStreak\s*\(/)
  assert.doesNotMatch(checker, /\bevalHeadroom\s*\(/)
  assert.doesNotMatch(
    checker,
    /firing\.push\(\{[^}]*kind:\s*['"](?:net_outflow_streak|headroom_thin)['"]/,
  )
  assert.match(checker, /FLOW_COVERAGE_DIAGNOSTICS/)
  assert.match(checker, /coverageFor\(venue, \{ hasInstant: exit !== null \}\)/)

  const oldFlowAlarms = [
    { id: 'one', venue: 'scrvUSD', kind: 'net_outflow_streak' },
    { id: 'two', venue: 'scrvUSD', kind: 'headroom_thin' },
  ]
  const { toInsert, toClear } = reconcileAlarms([], oldFlowAlarms)
  assert.deepEqual(toInsert, [])
  assert.deepEqual(toClear, oldFlowAlarms)
  assert.match(checker, /UNCERTIFIED_FLOW_KINDS\.has\(o\.kind\)/)
  assert.match(checker, /prior alarm evidence cannot be verified/)
})

test('independent gate and drawdown conditions still fire', () => {
  assert.match(checker, /const gate = evalGateChange\(/)
  assert.match(checker, /const draw = evalDrawdown\(/)
  const now = Date.parse('2026-09-27T00:00:00Z')
  const gate = evalGateChange(
    [{ kind: 'cooldown_duration_changed', at: '2026-09-26T23:00:00Z' }],
    now,
  )
  const draw = evalDrawdown([
    { at: '2026-09-20T00:00:00Z', value: 100 },
    { at: '2026-09-27T00:00:00Z', value: 70 },
  ])
  assert.equal(gate.fires, true)
  assert.equal(draw.fires, true)
  const { toInsert } = reconcileAlarms(
    [
      { venue: 'scrvUSD', kind: 'gate_change', severity: gate.severity, evidence: gate.evidence },
      { venue: 'scrvUSD', kind: 'drawdown_fast', severity: draw.severity, evidence: draw.evidence },
    ],
    [],
  )
  assert.deepEqual(
    toInsert.map(({ kind }) => kind),
    ['gate_change', 'drawdown_fast'],
  )
})

test('terms edits are separate event-keyed notices with independent expiry', () => {
  assert.match(checker, /termsNoticeRows\(/)
  assert.match(checker, /open\.filter\(isLegacyTermsOnlyGateAlarm\)/)
  const now = Date.parse('2026-09-27T00:00:00Z')
  const events = [
    {
      id: 'a',
      kind: 'terms_page_changed',
      at: '2026-09-26T22:00:00Z',
      next: { hash: 'A', source_url: 'https://example.org/terms' },
    },
    { kind: 'cooldown_duration_changed', at: '2026-09-26T23:00:00Z' },
    {
      id: 'b',
      kind: 'terms_page_changed',
      at: '2026-09-26T23:30:00Z',
      next: { hash: 'B', source_url: 'https://example.org/terms' },
    },
    {
      id: 'c',
      kind: 'terms_page_changed',
      at: '2026-09-26T23:45:00Z',
      next: { hash: 'A', source_url: 'https://example.org/terms-v2' },
    },
  ]
  const gate = evalGateChange(events, now)
  const terms = termsNoticeRows(events, 'scrvUSD', now)
  assert.equal(gate.evidence.count, 1)
  assert.deepEqual(
    terms.map((row) => row.sourceEventId),
    ['a', 'b', 'c'],
  )
  assert.ok(terms.every((row) => row.evidence.exitImpact === 'unclassified'))
  assert.deepEqual(
    terms.map((row) => row.evidence.sourceUrl),
    ['https://example.org/terms', 'https://example.org/terms', 'https://example.org/terms-v2'],
  )
  assert.equal(termsNoticeExpired(terms[0], Date.parse('2026-09-27T22:00:00Z')), true)
  assert.equal(termsNoticeExpired(terms[1], Date.parse('2026-09-27T22:00:00Z')), false)
  const old = {
    id: 'old',
    venue: 'scrvUSD',
    kind: 'gate_change',
    evidence: { count: 1, events: [events[0]] },
  }
  assert.equal(isLegacyTermsOnlyGateAlarm(old), true)
  const { toInsert } = reconcileAlarms(
    [{ venue: 'scrvUSD', kind: 'gate_change', ...gate }],
    [old].filter((row) => !isLegacyTermsOnlyGateAlarm(row)),
  )
  assert.deepEqual(
    toInsert.map((row) => row.kind),
    ['gate_change'],
  )
  assert.ok(
    checker.indexOf('for (const o of toClear)') < checker.indexOf('for (const f of toInsert)'),
  )
  const after = toInsert.map((row, index) => ({ ...row, id: `new-${index}` }))
  const repeated = reconcileAlarms(toInsert, after)
  assert.deepEqual(repeated.toInsert, [])
  assert.deepEqual(repeated.toClear, [])
  assert.deepEqual(
    termsNoticeRows(events, 'scrvUSD', now).map((r) => r.sourceEventId),
    ['a', 'b', 'c'],
  )
  const unsafe = termsNoticeRows(
    [
      {
        id: 'unsafe-id',
        kind: 'terms_page_changed',
        at: '2026-09-26T23:45:00Z',
        next: { source_url: 'https://user:pass@example.org/terms?token=secret' },
      },
    ],
    'scrvUSD',
    now,
  )
  assert.equal(unsafe[0].evidence.sourceUrlStatus, 'unavailable')
  assert.equal(unsafe[0].evidence.sourceUrl, undefined)
  assert.doesNotMatch(JSON.stringify(unsafe[0].evidence), /user|pass|secret/)
})

test('failed delivery retries while firing, notified or cleared rows stay quiet', async () => {
  const state = {
    rows: [],
    attempts: [],
    outcomes: [
      { ok: true, channels: ['logfile'], telegram: { configured: true, delivered: false } },
      {
        ok: true,
        channels: ['telegram', 'logfile'],
        telegram: { configured: true, delivered: true },
      },
    ],
    utilizationPct: 96,
    events: [],
    termsClaimed: [],
    termsBoundary: new Date(0),
  }
  globalThis.__venueAlarmRetryTest = state
  state.sql = async (strings, values) => {
    const query = strings.join('?')
    if (/^\s*SELECT boundary_at, status FROM venue_alarm_terms_migration/i.test(query))
      return [{ boundary_at: state.termsBoundary, status: 'test' }]
    if (/FROM venue_snapshots/i.test(query)) {
      return /ORDER BY observed_at DESC LIMIT 1/i.test(query)
        ? [
            {
              observed_at: new Date(),
              instant_usd: 100,
              params: { utilization_pct: state.utilizationPct },
            },
          ]
        : []
    }
    if (/FROM venue_events/i.test(query)) {
      assert.match(query, /observed_at > \(SELECT boundary_at FROM venue_alarm_terms_migration/)
      return state.events.map((event) => ({
        ...event,
        terms_eligible: new Date(event.at).getTime() > state.termsBoundary.getTime(),
      }))
    }
    if (/FROM venue_depth_curves/i.test(query)) return []
    if (
      /SELECT id, venue, kind, evidence, fired_at, source_event_id, notified FROM venue_alarms/i.test(
        query,
      )
    ) {
      return state.rows.filter((row) => row.cleared_at === null)
    }
    if (/UPDATE venue_alarms SET kind = 'terms_page_notice'/i.test(query)) {
      const row = state.rows.find(
        (item) =>
          item.id === values[1] &&
          item.kind === 'gate_change' &&
          item.cleared_at === null &&
          !item.notified,
      )
      if (!row) return []
      row.kind = 'terms_page_notice'
      row.severity = 'notice'
      row.evidence = JSON.parse(values[0])
      return [{ id: row.id }]
    }
    if (/UPDATE venue_alarms SET cleared_at/i.test(query)) {
      const row = state.rows.find(
        (item) => item.id === values[0] && item.kind === values[1] && item.cleared_at === null,
      )
      if (!row) return []
      row.cleared_at = new Date()
      return [{ id: row.id }]
    }
    if (/INSERT INTO venue_alarms/i.test(query)) {
      const [venue, kind, severity, evidence, sourceEventId] = values
      if (sourceEventId && state.rows.some((row) => row.source_event_id === sourceEventId))
        return []
      if (
        !sourceEventId &&
        state.rows.some(
          (row) => row.venue === venue && row.kind === kind && row.cleared_at === null,
        )
      )
        return []
      const row = {
        id: `alarm-${state.rows.length + 1}`,
        venue,
        kind,
        severity,
        evidence: JSON.parse(evidence),
        source_event_id: sourceEventId ?? null,
        fired_at: new Date(),
        notified: false,
        cleared_at: null,
      }
      state.rows.push(row)
      return [row]
    }
    if (/SELECT id, venue, kind, severity, evidence FROM venue_alarms/i.test(query)) {
      assert.match(
        query,
        /WHERE cleared_at IS NULL AND notified = false AND kind <> 'terms_page_notice'/i,
      )
      return state.rows.filter(
        (row) => row.kind !== 'terms_page_notice' && row.cleared_at === null && !row.notified,
      )
    }
    if (/WITH candidate AS/i.test(query)) {
      const token = values[0]
      const rows = state.rows
        .filter(
          (row) =>
            row.kind === 'terms_page_notice' &&
            row.cleared_at === null &&
            !row.notified &&
            !row.claim,
        )
        .slice(0, 25)
      for (const row of rows) row.claim = token
      state.termsClaimed.push(rows.map((row) => row.id))
      return rows
    }
    if (/UPDATE venue_alarms SET notified/i.test(query)) {
      assert.match(query, /cleared_at IS NULL AND notified = false/i)
      const row = state.rows.find(
        (item) => item.id === values[0] && item.cleared_at === null && !item.notified,
      )
      if (row) {
        row.notified = true
        row.claim = null
      }
      return []
    }
    if (/UPDATE venue_alarms SET delivery_claim_token = NULL/i.test(query)) {
      const row = state.rows.find((item) => item.id === values[0] && item.claim === values[1])
      if (row) row.claim = null
      return []
    }
    throw new Error(`unexpected alarm checker SQL: ${query}`)
  }

  const stubs = new Map([
    [
      '@neondatabase/serverless',
      'export const neon = () => (strings, ...values) => globalThis.__venueAlarmRetryTest.sql(strings, values)',
    ],
    [
      './lib/venue-reads.mjs',
      "export const readEnv = () => ({ get: (key) => key.startsWith('DATABASE_URL') ? 'mock' : null }); export const loadConfig = () => [{ name: 'scrvUSD', kind: 'vault', enabled: true, termsUrl: 'https://example.org/terms' }]",
    ],
    [
      './lib/notify.mjs',
      'export const notify = async (rows) => { const s = globalThis.__venueAlarmRetryTest; s.attempts.push(rows.map((row) => row.id)); return s.outcomes.shift() }',
    ],
    ['./lib/telegramBot.mjs', 'export const botConfig = () => ({ enabled: false })'],
  ])
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const code = stubs.get(specifier)
      return code
        ? { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true }
        : nextResolve(specifier, context)
    },
  })

  const oldLog = console.log
  console.log = () => {}
  try {
    for (let tick = 1; tick <= 3; tick++) {
      await import(`./check-venue-alarms.mjs?retry-test-tick=${tick}`)
    }
    assert.equal(state.rows.length, 1)
    assert.equal(state.rows[0].notified, true)
    assert.deepEqual(state.attempts, [['alarm-1'], ['alarm-1']])

    state.rows = []
    state.attempts = []
    state.outcomes = [{ ok: false, channels: [], telegram: { configured: true, delivered: false } }]
    await import('./check-venue-alarms.mjs?retry-test-tick=4')
    state.utilizationPct = 0
    await import('./check-venue-alarms.mjs?retry-test-tick=5')
    assert.equal(state.rows[0].notified, false)
    assert.ok(state.rows[0].cleared_at instanceof Date)
    assert.deepEqual(state.attempts, [['alarm-1']])

    state.rows = []
    state.attempts = []
    state.outcomes = [
      { ok: true, channels: ['logfile'], telegram: { configured: false, delivered: false } },
    ]
    state.utilizationPct = 96
    await import('./check-venue-alarms.mjs?retry-test-tick=6')
    assert.equal(state.rows[0].notified, true)
    assert.deepEqual(state.attempts, [['alarm-1']])

    state.rows = []
    state.attempts = []
    state.termsClaimed = []
    state.utilizationPct = 0
    const event = (id, hoursAgo, hash) => ({
      id,
      kind: 'terms_page_changed',
      at: new Date(Date.now() - hoursAgo * 3_600_000),
      prev: { hash: 'prior' },
      next: { hash, source_url: 'https://example.org/terms' },
    })
    state.events = [event('edit-a', 2, 'A'), event('edit-b', 1, 'B')]
    state.outcomes = Array.from({ length: 3 }, () => ({
      ok: true,
      channels: ['telegram'],
      telegram: { configured: true, delivered: true },
    }))
    await import('./check-venue-alarms.mjs?retry-test-tick=7')
    assert.deepEqual(
      state.rows.map((row) => row.source_event_id),
      ['edit-a', 'edit-b'],
    )
    assert.deepEqual(state.attempts, [['alarm-1'], ['alarm-2']])
    assert.ok(state.rows.every((row) => row.notified))
    await import('./check-venue-alarms.mjs?retry-test-tick=8')
    assert.equal(state.rows.length, 2)
    assert.equal(state.attempts.length, 2)

    // A→B→A changes the page twice even though the final hash repeats.
    state.events.push(event('edit-c', 0.5, 'A'))
    await import('./check-venue-alarms.mjs?retry-test-tick=9')
    assert.deepEqual(
      state.rows.map((row) => row.source_event_id),
      ['edit-a', 'edit-b', 'edit-c'],
    )
    assert.equal(state.attempts.length, 3)

    // A failed required channel releases its claim; a later run retries.
    state.events.push(event('edit-d', 0.25, 'C'))
    state.outcomes = [
      { ok: true, channels: ['logfile'], telegram: { configured: true, delivered: false } },
      { ok: true, channels: ['telegram'], telegram: { configured: true, delivered: true } },
    ]
    await import('./check-venue-alarms.mjs?retry-test-tick=10')
    assert.equal(state.rows[3].notified, false)
    assert.equal(state.rows[3].claim, null)
    await import('./check-venue-alarms.mjs?retry-test-tick=11')
    assert.equal(state.rows[3].notified, true)
    assert.deepEqual(state.attempts.slice(-2), [['alarm-4'], ['alarm-4']])

    // Concurrent checkers race for the same candidate; one atomic claim wins.
    state.events.push(event('edit-e', 0.1, 'D'))
    state.outcomes = [
      { ok: true, channels: ['telegram'], telegram: { configured: true, delivered: true } },
    ]
    await Promise.all([
      import('./check-venue-alarms.mjs?retry-test-tick=12'),
      import('./check-venue-alarms.mjs?retry-test-tick=13'),
    ])
    assert.equal(state.rows.filter((row) => row.source_event_id === 'edit-e').length, 1)
    assert.equal(state.attempts.filter((batch) => batch.includes('alarm-5')).length, 1)

    state.rows[0].evidence.firstObservedAt = new Date(Date.now() - 25 * 3_600_000).toISOString()
    await import('./check-venue-alarms.mjs?retry-test-tick=14')
    assert.ok(state.rows[0].cleared_at instanceof Date)
    assert.equal(state.rows[1].cleared_at, null)

    // Legacy aggregate rows remain deliverable, but pre-boundary source edits
    // cannot be remapped reliably and are not newly issued as event notices.
    state.termsBoundary = new Date(Date.now() - 3_600_000)
    state.rows = [
      {
        id: 'legacy-1',
        venue: 'scrvUSD',
        kind: 'terms_page_notice',
        severity: 'notice',
        evidence: {
          count: 1,
          latest: {
            kind: 'terms_page_changed',
            at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          },
        },
        source_event_id: null,
        notified: false,
        cleared_at: null,
        fired_at: new Date(),
      },
    ]
    state.events = [event('before-boundary', 2, 'A'), event('after-boundary', 0.5, 'B')]
    state.outcomes = Array.from({ length: 2 }, () => ({
      ok: true,
      channels: ['telegram'],
      telegram: { configured: true, delivered: true },
    }))
    state.attempts = []
    await import('./check-venue-alarms.mjs?retry-test-tick=15')
    assert.deepEqual(
      state.rows.map((row) => row.source_event_id),
      [null, 'after-boundary'],
    )
    assert.deepEqual(state.attempts, [['legacy-1'], ['alarm-2']])

    // A pre-migration terms-only gate row must become a factual notice without
    // being cleared before required Telegram delivery and its retry.
    state.rows = [
      {
        id: 'legacy-gate-1',
        venue: 'scrvUSD',
        kind: 'gate_change',
        severity: 'alarm',
        evidence: {
          count: 1,
          events: [
            {
              kind: 'terms_page_changed',
              at: new Date(Date.now() - 30 * 60_000).toISOString(),
              note: 'https://user:pass@example.org/terms?secret=yes',
            },
          ],
        },
        source_event_id: null,
        notified: false,
        cleared_at: null,
        fired_at: new Date(),
      },
    ]
    state.termsBoundary = new Date(Date.now() - 10 * 60_000)
    state.events = []
    state.outcomes = [
      { ok: true, channels: ['logfile'], telegram: { configured: true, delivered: false } },
      { ok: true, channels: ['telegram'], telegram: { configured: true, delivered: true } },
    ]
    state.attempts = []
    await import('./check-venue-alarms.mjs?retry-test-tick=16')
    assert.equal(state.rows[0].kind, 'terms_page_notice')
    assert.equal(state.rows[0].severity, 'notice')
    assert.equal(state.rows[0].cleared_at, null)
    assert.equal(state.rows[0].notified, false)
    assert.doesNotMatch(JSON.stringify(state.rows[0].evidence), /user|pass|secret/)
    await import('./check-venue-alarms.mjs?retry-test-tick=17')
    assert.equal(state.rows[0].notified, true)
    assert.deepEqual(state.attempts, [['legacy-gate-1'], ['legacy-gate-1']])

    // A pending aggregate from an overlapping old checker after the boundary
    // must yield to the event-keyed notice and release the real gate slot.
    state.rows = [
      {
        id: 'legacy-post-boundary',
        venue: 'scrvUSD',
        kind: 'gate_change',
        severity: 'alarm',
        evidence: {
          count: 1,
          events: [{ kind: 'terms_page_changed', at: new Date().toISOString() }],
        },
        source_event_id: null,
        notified: false,
        cleared_at: null,
        fired_at: new Date(),
      },
    ]
    state.events = [event('post-boundary-edit', 0.01, 'Z')]
    state.outcomes = [
      {
        ok: true,
        channels: ['telegram'],
        telegram: { configured: true, delivered: true },
      },
    ]
    state.attempts = []
    await import('./check-venue-alarms.mjs?retry-test-tick=18')
    assert.ok(state.rows[0].cleared_at instanceof Date)
    assert.equal(state.rows[1].source_event_id, 'post-boundary-edit')
    assert.deepEqual(state.attempts, [['alarm-2']])
  } finally {
    console.log = oldLog
    delete globalThis.__venueAlarmRetryTest
  }
})
