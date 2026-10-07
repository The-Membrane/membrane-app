// Config-card view-model (components/OracleRegistry/configViewModel.ts): state colours and
// glyphs, the red overlay (red wins the border in ANY state, the state stays written out),
// the announcement chip (never "announced" without evidence), ETA wording, headline, stale
// marker, route E cells, tab marks and the timeline filters.

import { describe, expect, it } from 'vitest'

import {
  announcementChip,
  asOfLine,
  batchRows,
  batchSummary,
  blockText,
  callKind,
  changeAnchor,
  changeHref,
  compactDigits,
  CONFIG_STALE_AFTER_SEC,
  configTabLabel,
  configTabMarks,
  delayText,
  dimensionCounts,
  eCell,
  etaText,
  filterRows,
  groupRows,
  hashToChangeId,
  headline,
  historicalAside,
  mergeTabs,
  oappSummary,
  parseView,
  readBeforeEta,
  RED_META,
  smallText,
  staleRedCount,
  permalinkLabel,
  unreadLines,
  redChips,
  remoteOperatorsDiffer,
  routeFlags,
  rowFrame,
  rowState,
  sourcesLine,
  STATE_META,
  stateText,
  tagChips,
} from '@/components/OracleRegistry/configViewModel'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import type { AssetSummary } from '@/lib/oracleRegistry/apiTypes'
import type {
  ConfigChangeView,
  ConfigCounts,
  ConfigTabSummary,
  RouteSideView,
} from '@/lib/oracleRegistry/config/apiTypes'

const row = (o: Partial<ConfigChangeView> = {}): ConfigChangeView => ({
  id: 'x',
  state: 'historical',
  stage: 'executed',
  dimension: 'bridge',
  title: 't',
  before: null,
  after: null,
  red: false,
  severity: 'neutral',
  floorBreach: false,
  ruleIds: [],
  tags: [],
  stillInEffect: false,
  announcement: 'not_checked',
  unannounced: null,
  chainId: 1,
  block: 100,
  blockFrom: null,
  ts: 1_700_000_000,
  eta: null,
  txUrl: null,
  queue: null,
  executableBy: null,
  signatures: null,
  route: null,
  notes: [],
  ...o,
})

const counts = (o: Partial<ConfigCounts> = {}): ConfigCounts => ({
  floorBreaches: 0,
  ruleBreaches: 0,
  redInEffect: 0,
  redOpen: 0,
  openRed: 0,
  redTotal: 0,
  pending: 0,
  armed: 0,
  stale: 0,
  proposed: 0,
  historical: 0,
  unread: 0,
  ...o,
})

const side = (o: Partial<RouteSideView> = {}): RouteSideView => ({
  chainId: 1,
  direction: 'receive',
  E: 4,
  live: true,
  shape: '4-of-4',
  operators: ['canary', 'layerzero-labs'],
  confirmations: '15',
  floorBreach: false,
  breaches: [],
  tags: [],
  warnings: [],
  display: 'eid 30110 (arbitrum) receive: E=4 · 4-of-4 (canary, layerzero-labs) · 15 conf',
  ...o,
})

describe('state vocabulary', () => {
  it('pending amber, proposed blue (its own token, not teal info), historical grey', () => {
    expect(STATE_META.pending.token).toBe(SEMANTIC_COLORS.warning)
    expect(STATE_META.proposed.token).toBe(SEMANTIC_COLORS.proposed)
    expect(STATE_META.proposed.token).not.toBe(SEMANTIC_COLORS.info)
    expect(STATE_META.historical.token).toBe(SEMANTIC_COLORS.textTertiary)
    expect(RED_META.token).toBe(SEMANTIC_COLORS.danger)
  })

  it('every state has a distinct glyph and a word (colour-blind safe)', () => {
    const metas = [...Object.values(STATE_META), RED_META]
    expect(new Set(metas.map((m) => m.glyph)).size).toBe(metas.length)
    for (const m of metas) expect(m.label).toMatch(/^[A-Z]+$/)
  })

  it('a stale op (past ETA, cannot execute) is its own grey state, not pending', () => {
    expect(rowState(row({ state: 'pending', stage: 'stale' }))).toBe('stale')
    expect(rowState(row({ state: 'pending', stage: 'armed' }))).toBe('pending')
    expect(rowState(row({ state: 'proposed', stage: 'safe_queued' }))).toBe('proposed')
  })
})

describe('rowFrame — the red overlay', () => {
  it('red wins the border over amber, but the state chip keeps the amber word', () => {
    const f = rowFrame(row({ state: 'pending', stage: 'armed', red: true }))
    expect(f.accent).toBe(RED_META.token)
    expect(f.outline).toBe(RED_META.token)
    expect(f.accentWidth).toBe('3px')
    expect(f.state).toBe(STATE_META.pending)
  })

  it('red wins in every state (proposed, historical, stale)', () => {
    for (const r of [
      row({ state: 'proposed', stage: 'safe_queued', red: true }),
      row({ state: 'historical', red: true }),
      row({ state: 'pending', stage: 'stale', red: true }),
    ])
      expect(rowFrame(r).accent).toBe(RED_META.token)
  })

  it('non-red pending is an amber border (no fill), proposed blue, historical quiet', () => {
    expect(rowFrame(row({ state: 'pending', stage: 'scheduled' }))).toMatchObject({
      accent: SEMANTIC_COLORS.warning,
      outline: SEMANTIC_COLORS.warning,
    })
    expect(rowFrame(row({ state: 'proposed' }))).toMatchObject({
      accent: SEMANTIC_COLORS.proposed,
      outline: SEMANTIC_COLORS.proposed,
    })
    expect(rowFrame(row())).toMatchObject({ outline: null, accentWidth: '1px' })
    expect(rowFrame(row({ state: 'pending', stage: 'stale' })).outline).toBeNull()
  })
})

describe('stateText / etaText', () => {
  const now = 1_791_262_535
  it('armed ops say ARMED; scheduled ones count down to the ETA', () => {
    expect(stateText(row({ state: 'pending', stage: 'armed', eta: now - 100 }), now)).toBe(
      'PENDING · ARMED',
    )
    expect(stateText(row({ state: 'pending', stage: 'scheduled', eta: now + 3 * 3600 }), now)).toBe(
      'PENDING · ETA in 3h',
    )
  })

  it('before the clock runs (SSR) the ETA is absolute, so markup matches', () => {
    expect(etaText(1_791_275_783, null)).toBe('ETA 2026-10-06 08:36 UTC')
  })

  it('a passed ETA says so; 0 / 1 sentinels are not ETAs', () => {
    expect(etaText(now - 2 * 86400, now)).toBe('ETA passed 2d ago')
    expect(etaText(1, now)).toBeNull()
    expect(etaText(null, now)).toBeNull()
  })

  it('stale, proposed (with signatures) and historical words', () => {
    expect(stateText(row({ state: 'pending', stage: 'stale', eta: now - 9 }), now)).toBe(
      'STALE · PAST ETA',
    )
    expect(stateText(row({ state: 'proposed', signatures: '2/5' }), now)).toBe(
      'PROPOSED · 2/5 SIGNED',
    )
    expect(stateText(row({ state: 'proposed' }), now)).toBe('PROPOSED')
    expect(stateText(row(), now)).toBe('HISTORICAL')
  })
})

describe('redChips', () => {
  it('DOWNGRADE and FLOOR BREACH in any state', () => {
    expect(redChips(row({ severity: 'downgrade', red: true, state: 'pending' }))).toEqual([
      'DOWNGRADE',
    ])
    expect(redChips(row({ floorBreach: true, red: true }))).toEqual(['FLOOR BREACH'])
  })

  it('STILL IN EFFECT only on a historical red whose result is live', () => {
    expect(redChips(row({ severity: 'downgrade', red: true, stillInEffect: true }))).toEqual([
      'DOWNGRADE',
      'STILL IN EFFECT',
    ])
    expect(redChips(row({ stillInEffect: true }))).toEqual([])
  })

  it('a neutral change has no red chip', () => {
    expect(redChips(row())).toEqual([])
  })
})

describe('announcementChip — never "announced" without evidence', () => {
  it('NO GOV CHANNEL and ANNOUNCEMENT NOT CHECKED carry the same (neutral) weight', () => {
    const a = announcementChip(row({ announcement: 'no_gov_channel' }))!
    const b = announcementChip(row({ announcement: 'not_checked' }))!
    expect(a.label).toBe('NO GOV CHANNEL')
    expect(b.label).toBe('ANNOUNCEMENT NOT CHECKED')
    expect(a.tone).toBe(b.tone)
  })

  it('UNANNOUNCED only when a matcher ran and found nothing', () => {
    expect(announcementChip(row({ unannounced: true }))).toMatchObject({
      label: 'UNANNOUNCED',
      tone: 'danger',
    })
    expect(announcementChip(row({ unannounced: false }))).toBeNull()
  })

  it('no chip text ever claims "announced"', () => {
    for (const r of [
      row({ announcement: 'no_gov_channel' }),
      row({ announcement: 'not_checked' }),
      row({ unannounced: true }),
    ])
      expect(announcementChip(r)!.label).not.toMatch(/^ANNOUNCED/)
  })
})

describe('blockText', () => {
  it('exact block, grid-bracketed range, queue block and off-chain proposals', () => {
    expect(blockText(row({ block: 24_784_877 }))).toBe('block 24,784,877')
    expect(blockText(row({ block: 26_085_464, blockFrom: 26_000_000 }))).toBe(
      'blocks 26,000,000–26,085,464',
    )
    expect(blockText(row({ block: 26_085_464, blockFrom: 26_085_463 }))).toBe('block 26,085,464')
    expect(blockText(row({ state: 'pending', block: 26_125_013 }))).toBe(
      'queued at block 26,125,013',
    )
    expect(blockText(row({ state: 'proposed', block: null }))).toBe('off-chain')
  })
})

describe('filters and groups', () => {
  const rows = [
    row({ id: 'a', state: 'pending', stage: 'armed', red: true, dimension: 'admin' }),
    row({ id: 'b', state: 'pending', stage: 'stale', dimension: 'admin' }),
    row({ id: 'c', state: 'proposed', dimension: 'bridge' }),
    row({ id: 'd', dimension: 'bridge', red: true }),
    row({ id: 'e', dimension: 'mint_redeem' }),
  ]

  it('groups pending / stale / proposed / historical apart', () => {
    const g = groupRows(rows)
    expect(g.pending.map((r) => r.id)).toEqual(['a'])
    expect(g.stale.map((r) => r.id)).toEqual(['b'])
    expect(g.proposed.map((r) => r.id)).toEqual(['c'])
    expect(g.historical.map((r) => r.id)).toEqual(['d', 'e'])
  })

  it('filters by dimension and red-only, together', () => {
    expect(filterRows(rows, { dimension: 'bridge', redOnly: false }).map((r) => r.id)).toEqual([
      'c',
      'd',
    ])
    expect(filterRows(rows, { dimension: null, redOnly: true }).map((r) => r.id)).toEqual([
      'a',
      'd',
    ])
    expect(filterRows(rows, { dimension: 'bridge', redOnly: true }).map((r) => r.id)).toEqual(['d'])
  })

  it('counts rows per dimension', () => {
    expect(dimensionCounts(rows)).toEqual({ bridge: 2, oracle: 0, admin: 2, mint_redeem: 1 })
  })

  it('historical count line: a trimmed total never reads as the filter result', () => {
    const trimmed = { historicalShown: 113, historicalTotal: 401, complete: false }
    const full = { historicalShown: 401, historicalTotal: 401, complete: true }
    expect(historicalAside({ matching: 113, filtered: false, timeline: trimmed })).toBe(
      '113 of 401 shown · every red row kept',
    )
    expect(historicalAside({ matching: 401, filtered: false, timeline: full })).toBe('401 executed')
    expect(historicalAside({ matching: 73, filtered: true, timeline: trimmed })).toBe(
      '73 match · 113 of 401 loaded',
    )
    expect(historicalAside({ matching: 73, filtered: true, timeline: full })).toBe(
      '73 of 401 match',
    )
  })
})

describe('headline', () => {
  it('always states floor breaches and pending; adds red flags only when present', () => {
    expect(headline('rsETH', counts({ floorBreaches: 1 }))).toBe(
      'rsETH: 1 floor breach · 0 pending · 0 proposed',
    )
    expect(headline('cbBTC', counts({ ruleBreaches: 6, redInEffect: 2 }))).toBe(
      'cbBTC: 0 floor breaches · 6 rule breaches · 2 red in effect · 0 pending · 0 proposed',
    )
    expect(headline('weETH', counts({ pending: 1, armed: 1, redOpen: 1, proposed: 2 }))).toBe(
      'weETH: 0 floor breaches · 1 red queued · 1 pending (1 armed) · 2 proposed',
    )
  })
})

describe('asOfLine — STALE marker', () => {
  const asOf = { block: 26_131_083, ts: 1_791_262_535 }
  it('fresh output: block, time and age', () => {
    const r = asOfLine(asOf, asOf.ts + 3600)
    expect(r.text).toBe('as of block 26,131,083 · 2026-10-06 04:55 UTC · 1h ago')
    expect(r.stale).toBe(false)
  })
  it('older than the threshold is STALE', () => {
    expect(asOfLine(asOf, asOf.ts + CONFIG_STALE_AFTER_SEC + 1).stale).toBe(true)
    expect(asOfLine(asOf, asOf.ts + CONFIG_STALE_AFTER_SEC).stale).toBe(false)
  })
  it('never collected reads as stale; SSR has no age', () => {
    expect(asOfLine({ block: 0, ts: 0 }, 1)).toEqual({ text: 'not collected yet', stale: true })
    expect(asOfLine(asOf, null).stale).toBe(false)
  })
})

describe('delayText / sourcesLine', () => {
  it('INSTANT with no pending window is flagged', () => {
    expect(delayText({ label: 'Mint', delayLabel: 'INSTANT', pendingObservable: false })).toEqual({
      key: 'Mint',
      value: 'INSTANT',
      noWindow: true,
    })
    expect(
      delayText({ label: 'Upgrade', delayLabel: '10d', pendingObservable: true }).noWindow,
    ).toBe(false)
  })

  it('summarises the proposed-change sources without overclaiming', () => {
    expect(
      sourcesLine([
        { kind: 'safe_tx_service', status: 'ok', note: null },
        { kind: 'safe_tx_service', status: 'ok', note: null },
        { kind: 'snapshot', status: 'not_ingested', note: null },
        { kind: 'discourse', status: 'not_ingested', note: null },
      ]),
    ).toBe('Safe queue: 2 read · Snapshot: not ingested · Forum: not ingested')
    expect(sourcesLine([{ kind: 'safe_tx_service', status: 'unavailable', note: null }])).toBe(
      'Safe queue: 1 unavailable',
    )
  })
})

describe('route cells', () => {
  it('a live side under the floor is red with ■; at the floor it is plain', () => {
    expect(eCell(side({ E: 1, floorBreach: true }))).toMatchObject({
      text: '1',
      glyph: RED_META.glyph,
      token: RED_META.token,
    })
    expect(eCell(side({ E: 2 }))).toMatchObject({ text: '2', glyph: '' })
  })

  it('REMOTE UNREAD never looks calm; closed / missing sides are quiet', () => {
    expect(eCell(null, 'no working public RPC')).toMatchObject({ text: 'UNREAD', glyph: '?' })
    expect(eCell(side({ live: false, shape: 'closed', E: 0 })).text).toBe('closed')
    expect(eCell(side({ live: false, shape: 'blocked', E: 0 })).text).toBe('off')
    expect(eCell(undefined).text).toBe('—')
  })

  it('oappSummary counts live, min E, floor breaches and remote coverage', () => {
    const r = (minE: number | null, live: boolean, floorBreach = false) =>
      ({
        eid: 1,
        chain: 'x',
        local: { send: null, receive: null },
        remote: null,
        live,
        minE,
        floorBreach,
      }) as const
    expect(
      oappSummary({
        routes: [r(4, true), r(1, true, true), r(null, false)],
        liveRoutes: 2,
        closedRoutes: 1,
        remoteRead: 1,
        remoteUnread: 1,
      }),
    ).toBe('2 live · min E 1 · 1 under floor · remote 1 read / 1 unread · 1 closed')
  })

  it('routeFlags: non-floor breaches, tags and warnings from every side, deduped, minus plumbing', () => {
    const bad = { ruleId: 'BR-7', message: 'unknown DVN 0xabcd…1234' }
    const f = routeFlags({
      local: {
        receive: side({
          breaches: [{ ruleId: 'BR-2', message: 'E=1 under the floor' }, bad],
          tags: ['deprecated_dvn'],
        }),
        send: side({ direction: 'send', tags: ['send_side', 'deprecated_dvn'], breaches: [bad] }),
      },
      remote: {
        chainId: 42161,
        address: null,
        url: null,
        receive: side({ warnings: ['REMOTE UNREAD', 'route closed', 'library past grace'] }),
        send: null,
        unread: null,
      },
    })
    // The floor already reads as ■ in the E cell; BR-7 is said once although two sides fail it.
    expect(f.breaches).toEqual([bad])
    expect(f.tags).toEqual(['deprecated DVN'])
    expect(f.warnings).toEqual(['library past grace'])
    expect(routeFlags({ local: { send: null, receive: null }, remote: null })).toEqual({
      breaches: [],
      tags: [],
      warnings: [],
    })
  })

  it('flags remote receive operators that differ from the Ethereum side', () => {
    expect(remoteOperatorsDiffer(side(), side({ operators: ['layerzero-labs', 'canary'] }))).toBe(
      false,
    )
    expect(remoteOperatorsDiffer(side(), side({ operators: ['layerzero-labs'] }))).toBe(true)
    expect(remoteOperatorsDiffer(side(), null)).toBe(false)
  })
})

describe('tags', () => {
  it('logic changes and stale rollbacks are loud; plumbing tags are quiet words', () => {
    expect(tagChips(['logic_change', 'stale_rollback', 'send_side'])).toEqual([
      { label: 'LOGIC CHANGE', loud: true },
      { label: 'STALE ROLLBACK', loud: true },
      { label: 'send side', loud: false },
    ])
  })
})

describe('tabs', () => {
  const summary = (o: Partial<ConfigTabSummary> = {}): ConfigTabSummary => ({
    subject: 'rseth',
    slug: 'rseth',
    symbol: 'rsETH',
    label: 'rsETH (Kelp)',
    oracleSlug: null,
    counts: counts(),
    asOf: null,
    ...o,
  })

  it('■n open red flags and ◐n pending; nothing when quiet', () => {
    // collected (asOf set); a summary with no collector output carries the ∅ mark (review 5)
    const collected = { asOf: { block: 1, ts: 1 } }
    expect(
      configTabMarks(summary({ ...collected, counts: counts({ openRed: 3, pending: 30 }) })),
    ).toEqual([
      expect.objectContaining({ glyph: '■', count: 3, token: RED_META.token }),
      expect.objectContaining({ glyph: '◐', count: 30, token: STATE_META.pending.token }),
    ])
    expect(configTabMarks(summary(collected))).toEqual([])
    expect(configTabMarks(null)).toEqual([])
  })

  it('spoken label', () => {
    expect(
      configTabLabel(summary({ asOf: { block: 1, ts: 1 }, counts: counts({ openRed: 1 }) })),
    ).toBe('1 config red flag')
    // collected and quiet (asOf set); a summary with no collector output is covered below
    expect(configTabLabel(summary({ asOf: { block: 1, ts: 1 } }))).toBe('config: no red flags')
  })

  it('merges oracle tabs with their config, then appends config-only subjects', () => {
    const asset = (slug: string) => ({ slug, symbol: slug }) as unknown as AssetSummary
    const tabs = mergeTabs(
      [asset('eth'), asset('weeth')],
      [summary({ slug: 'weeth', subject: 'weeth', oracleSlug: 'weeth' }), summary()],
    )
    expect(tabs.map((t) => [t.slug, !!t.oracle, t.config?.subject ?? null])).toEqual([
      ['eth', true, null],
      ['weeth', true, 'weeth'],
      ['rseth', false, 'rseth'],
    ])
  })
})

describe('deep links', () => {
  it('view param and change hash round-trip', () => {
    expect(parseView('config')).toBe('config')
    expect(parseView(undefined)).toBe('oracles')
    const id = '0x9f26d4c9:0xed8e78b0:0'
    const href = changeHref('weeth', id)
    expect(href.startsWith('?asset=weeth&view=config#')).toBe(true)
    expect(hashToChangeId(href.slice(href.indexOf('#')))).toBe(id)
    expect(hashToChangeId(`#${id}`)).toBe(id)
    expect(hashToChangeId('')).toBeNull()
  })

  it('the in-page anchor round-trips through the hash (ids carry colons)', () => {
    const id = '1:0xcb1f13:633:0x85d456b2:30325:receive'
    expect(changeAnchor(id)).toBe(`#${encodeURIComponent(id)}`)
    expect(hashToChangeId(changeAnchor(id))).toBe(id)
  })
})

describe('readBeforeEta — a pending op whose ETA passed after the last read', () => {
  const asOf = 1_791_262_535 // collector read at 04:55 UTC
  const eta = 1_791_275_783 // ETA 08:36 UTC
  it('true only once the clock is past an ETA that came after the read', () => {
    expect(readBeforeEta(eta, asOf, eta + 3600)).toBe(true)
    expect(readBeforeEta(eta, asOf, eta - 60)).toBe(false) // still ahead
    expect(readBeforeEta(eta, eta + 10, eta + 3600)).toBe(false) // read after the ETA
  })
  it('never during SSR, for sentinel ETAs, or without a read', () => {
    expect(readBeforeEta(eta, asOf, null)).toBe(false)
    expect(readBeforeEta(1, asOf, eta)).toBe(false)
    expect(readBeforeEta(null, asOf, eta)).toBe(false)
    expect(readBeforeEta(eta, 0, eta + 1)).toBe(false)
  })
})

describe('batches — the calls of one queued op fold into one item', () => {
  const q = (opId: string, kind: 'oz_timelock' | 'safe' = 'oz_timelock') => ({
    kind,
    address: '0xe8dc0fab349ea169283c48ccfd09d797e6db7c94',
    opId,
    label: 'Timelock 0xe8dc…7c94',
    url: null,
  })
  const pend = (id: string, title: string, opId: string, o: Partial<ConfigChangeView> = {}) =>
    row({
      id,
      title,
      state: 'pending',
      stage: 'scheduled',
      eta: 1_791_275_783,
      queue: q(opId),
      ...o,
    })

  it('callKind / batchSummary name the calls without their eid or address', () => {
    expect(callKind('Send config eid 30110: E=4 → E=4')).toBe('Send config')
    expect(callKind('Receive config, eid 30325 (movement): E=2 → E=2')).toBe('Receive config')
    expect(callKind('peer for eid 30183 → 0 (route closed)')).toBe('peer')
    expect(callKind('rate provider of 0x1695a2ff… → contract 0xee4f…6568')).toBe('rate provider')
    expect(callKind('upgrade 0x308861a4… → 0xd27a57bb…')).toBe('upgrade')
    expect(
      batchSummary([
        { title: 'Send config eid 30110: E=4 → E=4' },
        { title: 'Receive config eid 30110: E=4 → E=4' },
        { title: 'Send config eid 30106: E=4 → E=4' },
      ]),
    ).toBe('Send config ×2 · Receive config')
  })

  it('groups by op at the first call; lone calls and executed changes stay rows', () => {
    const items = batchRows([
      pend('a1', 'Send config eid 30110: E=4 → E=4', '0xaa'),
      pend('b1', 'upgrade 0x30… → 0xd2…', '0xbb', { red: true, stage: 'armed' }),
      pend('a2', 'Receive config eid 30110: E=4 → E=4', '0xaa', { red: true }),
      row({ id: 'h1', queue: q('0xaa') }), // executed: never folded
      row({ id: 'h2' }),
    ])
    expect(
      items.map((i) => (i.kind === 'row' ? i.row.id : `batch:${i.rows.map((r) => r.id)}`)),
    ).toEqual(['batch:a1,a2', 'b1', 'h1', 'h2'])
    const b = items[0]
    expect(b.kind === 'batch' && [b.head.id, b.redCount, b.summary]).toEqual([
      'a1',
      1,
      'Send config · Receive config',
    ])
  })

  it('a Safe proposal and a timelock op with the same id are different ops', () => {
    const items = batchRows([
      pend('s1', 'peer for eid 1 → 0', '0xcc', {
        state: 'proposed',
        stage: 'safe_queued',
        queue: q('0xcc', 'safe'),
      }),
      pend('t1', 'peer for eid 1 → 0', '0xcc'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['row', 'row'])
  })
})

describe('compactDigits — exact, never rounded', () => {
  it('long round integers become powers of ten', () => {
    expect(compactDigits('Deposit limit ETH: 100000000000000000000000000')).toBe(
      'Deposit limit ETH: 1e26',
    )
    expect(compactDigits('limit 15000000000000000000 wei')).toBe('limit 1.5e19 wei')
    expect(compactDigits('1000000000000000000 → 2000000000000000000')).toBe('1e18 → 2e18')
  })
  it('leaves non-round values, short numbers, hex and decimals alone', () => {
    const odd = '123456789012345678901'
    expect(compactDigits(odd)).toBe(odd)
    expect(compactDigits('block 26,131,083 · 64 conf · 1000000 conf')).toBe(
      'block 26,131,083 · 64 conf · 1000000 conf',
    )
    expect(compactDigits('0x0000000000000000000000001000000000000000')).toBe(
      '0x0000000000000000000000001000000000000000',
    )
    expect(compactDigits('0.10000000000000000000')).toBe('0.10000000000000000000')
  })
})

describe('review fixes 2026-10-06 (view model)', () => {
  it('no collector output: the headline and the tab never state zeros or "no red flags"', () => {
    const quiet = {
      floorBreaches: 0,
      ruleBreaches: 0,
      redInEffect: 0,
      redOpen: 0,
      openRed: 0,
      redTotal: 0,
      pending: 0,
      armed: 0,
      stale: 0,
      proposed: 0,
      historical: 0,
      unread: 0,
    }
    expect(headline('rsETH', quiet, false)).toMatch(/not collected/)
    expect(headline('rsETH', quiet, false)).not.toMatch(/0 floor breaches/)
    expect(headline('rsETH', quiet)).toBe('rsETH: 0 floor breaches · 0 pending · 0 proposed')
    const tab = {
      subject: 'rseth',
      slug: 'rseth',
      symbol: 'rsETH',
      label: 'rsETH',
      oracleSlug: null,
      counts: quiet,
      asOf: null,
    }
    expect(configTabLabel(tab)).toBe('config: not collected')
  })

  it('an UNREAD local side reads UNREAD (amber ?), not "off"', () => {
    const c = eCell({
      chainId: 1,
      direction: 'receive',
      E: null,
      live: false,
      shape: 'config UNREAD — HTTP 503',
      operators: [],
      confirmations: null,
      floorBreach: false,
      breaches: [],
      tags: [],
      warnings: ['UNREAD'],
      display: 'eid 30110 (arbitrum) receive: config UNREAD — HTTP 503',
      unread: 'HTTP 503',
    })
    expect(c.text).toBe('UNREAD')
    expect(c.token).toBe(SEMANTIC_COLORS.warning)
  })

  it('small state words and red chips use AA-contrast text tokens', () => {
    expect(STATE_META.historical.text).toBe(SEMANTIC_COLORS.textSecondary)
    expect(STATE_META.stale.text).toBe(SEMANTIC_COLORS.textSecondary)
    expect(RED_META.text).toBe(SEMANTIC_COLORS.dangerText)
    expect(smallText(SEMANTIC_COLORS.danger)).toBe(SEMANTIC_COLORS.dangerText)
  })
  it('a red stale op opens the Stale group; permalinks and unread reasons are named in text', () => {
    expect(staleRedCount([row({ state: 'pending', stage: 'stale', red: true }), row()])).toBe(1)
    expect(staleRedCount([row({ state: 'pending', stage: 'stale' })])).toBe(0)
    expect(permalinkLabel('upgrade x')).toBe('Permalink to this change: upgrade x')
    const s = side({ unread: 'HTTP 503', warnings: ['UNREAD'] })
    expect(
      unreadLines({
        local: { receive: s, send: null },
        remote: {
          chainId: 42161,
          address: null,
          url: null,
          send: null,
          receive: null,
          unread: 'no RPC',
        },
      }),
    ).toEqual(['remote side not read: no RPC', 'Ethereum receive side not read: HTTP 503'])
  })
})
