/** Server-only pinned raw-receipt approval. Never import this loader into browser code. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  AcceptMorphoV2ProtocolEvidence,
  MorphoV2HolderTimeProcessInput,
  MorphoV2ProtocolPoint,
} from './morphoV2HolderTimeProcess'

const PIN = Object.freeze({
  file: 'data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.json',
  fileSha256: 'ddf285e8d5209390ce2b8c42867b092fa36ddaf0a8759e2a83dd92805740f970',
  receiptSha256: '4442d5f337123ee4d47e3bce8a02a92909901d43affefe64709f6b41b15dcaa1',
  maxBytes: 1024 * 1024,
})
type History = MorphoV2HolderTimeProcessInput['history'] & {
  sourceImplementationEquivalence: false
}
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
    )
  return Object.is(a, b)
}
function freeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
/** Only the exact external file pin is eligible. Replay also independently validates
 * native calldata/results, both approved hostname classifications, header enclosure,
 * dependencies, fixed setup, runtime/config identities, source clocks and budgets.
 * It does not fetch, construct holder E, or approve current native evidence. */
export async function replayMorphoV2PilotHistoricalEvidence(rawText: string) {
  if (
    typeof rawText !== 'string' ||
    Buffer.byteLength(rawText, 'utf8') > PIN.maxBytes ||
    digest(rawText) !== PIN.fileSha256
  )
    throw Error('morpho_pilot_history_file_pin')
  const receipt = JSON.parse(rawText),
    { sha256, ...body } = receipt
  if (sha256 !== PIN.receiptSha256 || digest(JSON.stringify(body)) !== PIN.receiptSha256)
    throw Error('morpho_pilot_history_body_pin')
  const collector = await import('../../scripts/research/morpho-v2-adapter-capacity-capture.mjs')
  // This independently verifies the two original sealed local-cash seed files too.
  const plan = collector.prepareMorphoV2AdapterCapacityPlan()
  const replay = await collector.replayMorphoV2AdapterCapacityCooperatively(receipt, plan)
  if (
    replay.captureReceiptSha256 !== PIN.receiptSha256 ||
    replay.historyRegimeMatch !== true ||
    replay.history.points.length !== 2 ||
    replay.sourceImplementationEquivalence !== false
  )
    throw Error('morpho_pilot_history_replay')
  const points: MorphoV2ProtocolPoint[] = replay.history.points.map((p: any) => {
    if (
      p.status !== 'two_origin_conditional_configured_adapter_prongs' ||
      !p.facts ||
      p.origins.length !== 2 ||
      p.origins.some((o: any) => !o.facts)
    )
      throw Error('morpho_pilot_history_origins')
    const g = p.facts
    return {
      source: structuredClone(p.source),
      status: p.status,
      prongs: {
        idleCashRaw: g.idleCashRaw,
        blueCashRaw: g.blueCashRaw,
        market: [...g.market],
        internalSharesRaw: g.adapterInternalSharesRaw,
        actualSharesRaw: g.bluePositionSharesRaw,
        allowanceRaw: g.adapterAllowanceRaw,
        allocationsRaw: [...g.allocationsRaw],
        borrowRateRaw: g.borrowRateRaw,
        feeRecipient: g.feeRecipient,
      },
    }
  })
  const base = replay.history.points[0].facts
  const evidence: History = {
    subject: structuredClone(replay.subject),
    configured: {
      adapter: base.liquidityAdapter,
      morpho: collector.CONFIGURED.morpho,
      irm: collector.CONFIGURED.irm,
      marketId: base.marketId,
      liquidityData: base.liquidityData,
      allocationIds: [...base.allocationIds],
    },
    runtimeIdentities: Object.entries(base.runtimeIdentities).map(
      ([key, value]: [string, any]) => ({
        key,
        codeHash: value.keccak256,
        proxyInspection: value.proxyInspection,
        implementationAddress: value.implementationAddress,
        implementationCodeHash: value.implementationCodeHash,
      }),
    ),
    captureReceiptSha256: PIN.receiptSha256,
    knowledgeCutoff: replay.knowledgeCutoff,
    history: {
      points,
      elapsedSeconds: [
        0,
        (Date.parse(points[1].source.blockTime) - Date.parse(points[0].source.blockTime)) / 1000,
      ],
    },
    sourceImplementationEquivalence: false,
  }
  const trusted = freeze(structuredClone(evidence))
  const acceptEvidence: AcceptMorphoV2ProtocolEvidence = (kind, candidate) => {
    try {
      return kind === 'history' && exact(structuredClone(candidate), trusted)
    } catch {
      return false
    }
  }
  // Return a clone: consumer mutation cannot change the closure's authority.
  return {
    evidence: structuredClone(trusted),
    acceptEvidence,
    provenance: {
      file: PIN.file,
      fileSha256: PIN.fileSha256,
      receiptSha256: PIN.receiptSha256,
      physicalStarts: receipt.physicalStarts,
      knowledgeCutoff: replay.knowledgeCutoff,
      currentEvidenceApproved: false as const,
    },
  }
}
export async function loadMorphoV2PilotHistoricalEvidence() {
  const { readBoundedReceiptFile } = await import('../../scripts/lib/boundedLocalReceiptFile.mjs')
  const text = readBoundedReceiptFile(resolve(PIN.file), {
    maxFileBytes: PIN.maxBytes,
    maxTotalBytes: PIN.maxBytes,
    totalBytes: 0,
  })
  return replayMorphoV2PilotHistoricalEvidence(text)
}
