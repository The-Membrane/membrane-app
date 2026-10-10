import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256, stringToHex } from 'viem'
import { loadMorphoV2PilotHistoricalEvidence } from '@/lib/carry/morphoV2PilotHistoricalEvidence'
import {
  MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN,
  approveMorphoV2PinnedProtocolHistory,
  morphoV2PinnedProtocolHistory,
} from '@/lib/carry/morphoV2ProtocolCapacityHistoryPins'

const nodeSha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const browserSha = (text: string) => sha256(stringToHex(text)).slice(2)

describe('immutable Morpho pilot full historical frame', () => {
  it('exactly matches the complete 190-call pinned raw replay and literal frame digest', async () => {
    const loaded = await loadMorphoV2PilotHistoricalEvidence()
    const frame = morphoV2PinnedProtocolHistory()
    expect(loaded.provenance.physicalStarts).toBe(190)
    expect(loaded.provenance.fileSha256).toBe(MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN.rawFileSha256)
    expect(loaded.provenance.receiptSha256).toBe(
      MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN.captureReceiptSha256,
    )
    expect(frame).toEqual(loaded.evidence)
    const text = readFileSync(
      resolve(
        'data/research/venue-signals/morpho-v2-protocol-capacity-history-pilot-2026-10-07T15-32.frame.json',
      ),
      'utf8',
    )
    expect(text).toBe(JSON.stringify(frame))
    expect(nodeSha(text)).toBe(MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN.frameSha256)
    expect(browserSha(text)).toBe(nodeSha(text))
    expect(approveMorphoV2PinnedProtocolHistory(loaded.evidence, browserSha)).toBe(true)
  })

  it('keeps private approval authority independent from getter clones and supplied digests', () => {
    const mutated = morphoV2PinnedProtocolHistory()
    mutated.history.points[0].prongs.blueCashRaw = '0'
    expect(approveMorphoV2PinnedProtocolHistory(mutated, nodeSha)).toBe(false)
    expect(approveMorphoV2PinnedProtocolHistory(morphoV2PinnedProtocolHistory(), nodeSha)).toBe(
      true,
    )
    expect(
      approveMorphoV2PinnedProtocolHistory(morphoV2PinnedProtocolHistory(), () => '0'.repeat(64)),
    ).toBe(false)
  })

  it('rejects omitted or promoted proxy and source-equivalence identities', () => {
    const frame = morphoV2PinnedProtocolHistory()
    expect(frame.sourceImplementationEquivalence).toBe(false)
    for (const identity of frame.runtimeIdentities) {
      expect(identity.implementationAddress).toBeNull()
      expect(identity.implementationCodeHash).toBeNull()
    }
    for (const mutate of [
      (value: any) => delete value.sourceImplementationEquivalence,
      (value: any) => (value.sourceImplementationEquivalence = true),
      (value: any) => delete value.runtimeIdentities[0].implementationAddress,
      (value: any) => (value.runtimeIdentities[0].implementationCodeHash = `0x${'1'.repeat(64)}`),
    ]) {
      const candidate = structuredClone(frame)
      mutate(candidate)
      expect(approveMorphoV2PinnedProtocolHistory(candidate, nodeSha)).toBe(false)
    }
  })
})
