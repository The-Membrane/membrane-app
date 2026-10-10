import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  loadMorphoV2PilotHistoricalEvidence,
  replayMorphoV2PilotHistoricalEvidence,
} from '@/lib/carry/morphoV2PilotHistoricalEvidence'
const PATH = 'data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.json'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
describe('server-only exact Morpho pilot historical approval', () => {
  it('replays the actual pinned raw190 receipt and derives both exact native historical snapshots', async () => {
    const r = await loadMorphoV2PilotHistoricalEvidence()
    expect(r.provenance.physicalStarts).toBe(190)
    expect(r.provenance.fileSha256).toBe(sha(readFileSync(PATH, 'utf8')))
    expect(r.evidence.history.elapsedSeconds).toEqual([0, 86400])
    expect(r.evidence.history.points.map((p) => p.source.blockNumber)).toEqual([
      '26100913',
      '26108081',
    ])
    expect(r.evidence.history.points.map((p) => p.prongs.market)).toEqual([
      r.evidence.history.points[0].prongs.market,
      r.evidence.history.points[0].prongs.market,
    ])
    expect(r.evidence.runtimeIdentities).toHaveLength(5)
    expect(r.evidence.history.points[0].prongs.internalSharesRaw).toBe('986418728075')
    expect(r.evidence.knowledgeCutoff).toBe('2026-10-07T15:37:57.975Z')
    expect(r.evidence.sourceImplementationEquivalence).toBe(false)
    expect(r.acceptEvidence('history', r.evidence)).toBe(true)
    expect(r.acceptEvidence('current', r.evidence)).toBe(false)
  })
  it('rejects modified file bytes and resealed config/raw/header/clock changes despite a valid self seal', async () => {
    const original = readFileSync(PATH, 'utf8')
    await expect(replayMorphoV2PilotHistoricalEvidence(original + ' ')).rejects.toThrow('file_pin')
    for (const mutate of [
      (r: any) => (r.plan.subject.assetDecimals = 18),
      (r: any) => (r.traces.find((t: any) => t.key === 'market').response.result = '0x00'),
      (r: any) =>
        (r.traces.find((t: any) => t.key === 'header_before').response.result.hash =
          `0x${'b'.repeat(64)}`),
      (r: any) => (r.capturedAt = '2026-10-07T15:00:00.000Z'),
      (r: any) => (r.origins[1] = r.origins[0]),
    ]) {
      const r = JSON.parse(original)
      mutate(r)
      const { sha256, ...body } = r
      r.sha256 = sha(JSON.stringify(body))
      await expect(replayMorphoV2PilotHistoricalEvidence(JSON.stringify(r))).rejects.toThrow(
        'file_pin',
      )
    }
  })
  it('rejects altered post-approval evidence and isolates the private snapshot from exposed aliases', async () => {
    const { evidence, acceptEvidence } = await loadMorphoV2PilotHistoricalEvidence(),
      saved = structuredClone(evidence)
    for (const mutate of [
      (e: any) => (e.configured.marketId = `0x${'c'.repeat(64)}`),
      (e: any) => (e.history.points[0].source.blockHash = `0x${'c'.repeat(64)}`),
      (e: any) => (e.history.points[1].prongs.blueCashRaw = '1'),
      (e: any) => (e.runtimeIdentities[0].codeHash = `0x${'c'.repeat(64)}`),
      (e: any) => (e.knowledgeCutoff = '2026-10-07T15:00:00.000Z'),
    ]) {
      const e = structuredClone(saved)
      mutate(e)
      expect(acceptEvidence('history', e)).toBe(false)
    }
    evidence.history.points[0].prongs.market[0] = '1'
    evidence.configured.adapter = 'bad'
    expect(acceptEvidence('history', saved)).toBe(true)
    expect(acceptEvidence('history', evidence)).toBe(false)
    expect(acceptEvidence('history', null as never)).toBe(false)
    expect(acceptEvidence('current', saved)).toBe(false)
  })
})
