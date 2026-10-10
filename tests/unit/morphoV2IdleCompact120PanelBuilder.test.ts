import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildMorphoV2IdleCompact120Panel, loadMorphoV2IdleCompact120SourceCopies,
  MORPHO_V2_IDLE_COMPACT120_MANIFEST_SHA256, type MorphoV2IdleCompact120SourceCopies,
} from '@/scripts/research/morpho-v2-idle-compact120-panel-builder'
import { expandMorphoV2IdleCompactEndpoint, MORPHO_V2_IDLE_COMPACT120_MAX_BYTES } from '@/lib/carry/morphoV2IdleCompact120Panel'

// Actual fixed parent-accepted corpus. No synthetic native facts or approval flags.
const source = loadMorphoV2IdleCompact120SourceCopies()
function built(value: MorphoV2IdleCompact120SourceCopies = source) {
  const result = buildMorphoV2IdleCompact120Panel(value)
  expect(result).not.toBeNull()
  if (!result) throw new Error('expected_fixed_compact_panel')
  return result
}
const replace = (name: string, value: Uint8Array) => ({ ...source, copies: new Map([...source.copies, [name, value]]) })

describe('offline fixed PYUSD compact120 extraction', () => {
  it('retains every planned endpoint and pair with the actual 108/12 and 53-comparison denominators', () => {
    const { panel } = built()
    expect(panel.endpoints).toHaveLength(120)
    expect(panel.cohorts).toHaveLength(60)
    expect(panel.pairs).toHaveLength(60)
    expect(panel.counts).toEqual({ plannedEndpoints: 120, usableEndpoints: 108, censoredEndpoints: 12,
      plannedPairs: 60, nativeEndpointPairs: 54, jointComparisons: 53, censoredJointPairs: 7 })
    expect(panel.pairs.filter(p => p[0] === 'scored')).toHaveLength(53)
    expect(panel.pairs.filter(p => p[0] === 'censored')).toHaveLength(7)
  })

  it('preserves real zero cash and native recorded-probe quotes for blocked older configurations', () => {
    const { panel } = built()
    expect(panel.endpoints.filter(p => p[3] === '0')).toHaveLength(13)
    expect(panel.endpoints[0][3]).toBe('0')
    expect(panel.endpoints[0][4]).toBe('708376')
    expect(panel.endpoints[0][5]).toBe('288859387382880')
    expect(panel.endpoints[0][6]).toBe('143865600404980367169544334')
    expect(panel.endpoints[0][7]).toBe('99634412598996431')
    expect(panel.recordedProbe.sharesRaw).toBe('352805058661206444')
    expect(panel.recordedProbe.quoteKind).toBe('native_preview_redeem_recorded_probe_stock')
    expect(panel.recordedProbe.historicalOwnedEntitlement).toBeNull()
    const censored = panel.endpoints.filter(p => p[9] !== 0)
    expect(censored).toHaveLength(12)
    for (const point of censored) {
      expect(panel.regimes[point[8]].liquidityAdapter).toBe('0x80126555b170957dfed67a3bfbb7893e20fe4fc0')
      expect(panel.censorReasons[point[9]]).toEqual(['idle_regime_differed', 'configuration_or_runtime_mismatch'])
      expect(BigInt(point[4])).toBeGreaterThan(0n)
    }
  })

  it('adapts only the committed legacy_v2 anchors with omitted zero flags and rejects changed legacy scalars', () => {
    const { panel } = built()
    const name = 'result__cohort-59.json'
    const legacy = JSON.parse(Buffer.from(source.copies.get(name)!).toString())
    expect(legacy.originalInspector).toBe('legacy_v2')
    expect(legacy.directory).toBe('data/research/venue-signals/pyusd-b576-idle-history-v2-2026-10-10T05-29-29.760Z-b9d9aa95-5eec-4e5d-92af-fd6b4d3d6091')
    const anchors = legacy.report.points.filter((p: { label: string }) => p.label !== 'current')
    expect(anchors.map((p: Record<string, unknown>) => [p.CAssetRaw, p.probeEaAssetRaw])).toEqual([
      ['20919825104652', '713612'], ['24375516077801', '713661'],
    ])
    for (let side = 0; side < 2; side++) {
      expect(Object.hasOwn(anchors[side], 'measuredZeroCash')).toBe(false)
      expect(Object.hasOwn(anchors[side], 'measuredZeroEntitlement')).toBe(false)
      expect(panel.endpoints[118+side].slice(3, 5)).toEqual([anchors[side].CAssetRaw, anchors[side].probeEaAssetRaw])
    }
    for (const field of ['CAssetRaw', 'probeEaAssetRaw']) {
      const changed = JSON.parse(Buffer.from(source.copies.get(name)!).toString())
      changed.report.points.find((p: { label: string }) => p.label === 'anchor_0')[field] = '0'
      expect(buildMorphoV2IdleCompact120Panel(replace(name, Buffer.from(JSON.stringify(changed))))).toBeNull()
    }
  })

  it('keeps native units, asset identity and runtime evidence distinct from cash and quote scalars', () => {
    const { panel } = built()
    expect(panel.identity.assetDecimals).toBe(6)
    expect(panel.identity.shareDecimals).toBe(18)
    expect(panel.identity.destination).toBe('0xb576765fb15505433af24fee2c0325895c559fb2')
    expect(panel.identity.asset).toBe('0x6c3ea9036406852006290770bedfcaba0e23a0e8')
    for (const regime of panel.regimes) {
      expect(regime.vaultRuntime).toEqual({ bytes: 21808, keccak256: '0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd' })
      expect(regime.assetRuntime.bytes).toBe(1506)
      expect(regime.ownerRuntime.bytes).toBe(0)
    }
    expect(panel.endpoints.some(p => p[3] !== p[5])).toBe(true)
    expect(panel.endpoints.some(p => p[7] !== panel.recordedProbe.sharesRaw)).toBe(true)
  })

  it('retains exact canonical H24 endpoint sources and chronological partition boundaries', () => {
    const { panel } = built()
    expect(new Set(panel.endpoints.map(p => p[1])).size).toBe(120)
    for (let pair = 0; pair < 60; pair++) {
      expect(Date.parse(panel.endpoints[pair*2+1][2])-Date.parse(panel.endpoints[pair*2][2])).toBe(86400000)
    }
    expect(expandMorphoV2IdleCompactEndpoint(panel, 39)?.retrospectivePartition).toBe('fit')
    expect(expandMorphoV2IdleCompactEndpoint(panel, 40)?.retrospectivePartition).toBe('calibration')
    expect(expandMorphoV2IdleCompactEndpoint(panel, 80)?.retrospectivePartition).toBe('holdout')
    expect(expandMorphoV2IdleCompactEndpoint(panel, 0)?.source.blockHash).toBe(panel.endpoints[0][1])
    for (const index of [-1, 120, 0.5, NaN]) expect(expandMorphoV2IdleCompactEndpoint(panel, index)).toBeNull()
    expect(panel.disclosure.dailyEndpointsCertifyContinuousDuration).toBe(false)
    expect(panel.disclosure.modeledSamplesAreNativeOutcomes).toBe(false)
  })

  it('preserves cold-start censorship and separate all-native versus matched persistence', () => {
    const { panel } = built()
    expect(panel.pairs[6]).toEqual(['censored', 'cold_start_no_strictly_prior_usable_donor', 0, 0])
    expect(panel.pairs[7]).toEqual(['scored', null, 1, 1])
    expect(panel.retrospectiveScores.joint.comparisons).toBe(53)
    expect(panel.retrospectiveScores.matchedPersistence.comparisons).toBe(53)
    expect(panel.retrospectiveScores.allNativePersistence.comparisons).toBe(54)
    expect(panel.retrospectiveScores.joint.availableAbsoluteErrorSumRaw).toBe('727336')
    expect(panel.retrospectiveScores.matchedPersistence.availableAbsoluteErrorSumRaw).toBe('715779')
    expect(panel.retrospectiveScores.joint.shortfallAbsoluteErrorSumRaw).toBe('509433')
    expect(panel.retrospectiveScores.matchedPersistence.shortfallAbsoluteErrorSumRaw).toBe('500000')
    expect(panel.retrospectiveScores.availableErrorImproved).toBe(false)
    expect(panel.retrospectiveScores.shortfallErrorImproved).toBe(false)
    expect(panel.disclosure.competingMRaw).toBeNull()
    expect(panel.disclosure.additionalCompetingFlowSubtraction).toBe(false)
  })

  it('separates facts availability and recorded collection clocks from historical source clocks', () => {
    const { panel } = built()
    expect(panel.actualAvailabilityAtUtc).toBe('2026-10-10T10:04:06.305Z')
    expect(panel.endpoints[0][2]).toBe('2026-06-05T23:59:59.000Z')
    expect(panel.cohorts.filter(c => c[7] === null)).toHaveLength(5)
    expect(panel.cohorts[0][7]).toBe('2026-10-10T08:13:52.703Z')
    expect(expandMorphoV2IdleCompactEndpoint(panel, 20)?.nativeAcquisitionCompletedAtUtc).toBeNull()
  })

  it('commits separate whole-file hashes and body seals without treating preservation as native authority', () => {
    const { panel } = built()
    expect(panel.sourceCommitments.retentionManifestFileSha256).toBe(MORPHO_V2_IDLE_COMPACT120_MANIFEST_SHA256)
    expect(panel.sourceCommitments.replayTerminalFileSha256).toBe('aa0c2c6bbbd44ca947828fc1d3fcfdd61d0732fb9344194f187b659f920dbd7e')
    expect(panel.sourceCommitments.referencesFileSha256).toBe('fa90684008871b81e6f8cec698ccfd74a4ee2de4fa323ea3c3075091f37371e7')
    for (const cohort of panel.cohorts) {
      expect(cohort[1]).not.toBe(cohort[2])
      expect(cohort[3]).not.toBe(cohort[4])
    }
    expect(Object.values(panel.claims).every(v => v === false)).toBe(true)
    expect(Object.isFrozen(panel)).toBe(true)
    expect('receipt' in panel).toBe(false)
    expect('approved' in panel).toBe(false)
  })

  it('produces canonical minified UTF8 JSON without newline under64KiB and a reproducible digest', () => {
    const first = built(), second = built()
    expect(first.text).toBe(JSON.stringify(JSON.parse(first.text)))
    expect(first.text.endsWith('\n')).toBe(false)
    expect(first.bytes).toBe(Buffer.byteLength(first.text))
    expect(first.bytes).toBeLessThanOrEqual(MORPHO_V2_IDLE_COMPACT120_MAX_BYTES)
    expect(first.sha256).toBe(createHash('sha256').update(first.text).digest('hex'))
    expect(second.text).toBe(first.text)
  })

  it('rejects even semantically equivalent manifest reserialization without the fixed byte pin', () => {
    const changed = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(source.manifestBytes).toString())))
    expect(buildMorphoV2IdleCompact120Panel({ ...source, manifestBytes: changed })).toBeNull()
  })

  it('rejects missing or extra copied leaves', () => {
    const missing = new Map(source.copies); missing.delete('result__cohort-00.json')
    expect(buildMorphoV2IdleCompact120Panel({ ...source, copies: missing })).toBeNull()
    const extra = new Map(source.copies); extra.set('not-approved.json', Buffer.from('{}'))
    expect(buildMorphoV2IdleCompact120Panel({ ...source, copies: extra })).toBeNull()
  })

  it('rejects changed native cash/quote/source facts and false green flags at the whole-file commitment', () => {
    const original = JSON.parse(Buffer.from(source.copies.get('result__cohort-00.json')!).toString())
    original.report.points[1].CAssetRaw = '1'
    original.report.points[1].probeEaAssetRaw = '1'
    original.report.points[1].source.blockHash = '0x'+'0'.repeat(64)
    original.qualifiedNativeJoin = true
    expect(buildMorphoV2IdleCompact120Panel(replace('result__cohort-00.json', Buffer.from(JSON.stringify(original))))).toBeNull()
  })

  it('rejects truncated copied bytes and a source whose copies are not the closed Map', () => {
    const b = source.copies.get('result__header-replay.json')!
    expect(buildMorphoV2IdleCompact120Panel(replace('result__header-replay.json', b.slice(0, b.length-1)))).toBeNull()
    expect(buildMorphoV2IdleCompact120Panel({ ...source, copies: {} } as unknown as MorphoV2IdleCompact120SourceCopies)).toBeNull()
  })
})
