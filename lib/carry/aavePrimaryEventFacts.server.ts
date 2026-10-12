import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { readBoundedReceiptFile } from '../../scripts/lib/boundedLocalReceiptFile.mjs'
import type { RouteEventQuestion } from './routeEventContext'
import type { ReviewedPrimaryEvent } from './primaryEventNetScenario'

const SHA = '17e896684f87f87eb65ba446fa87093647f1a953da522a8b421a4423ae7c003b'
const CONFIGURATOR = '0x64b761d848206f447fe2dd461b0c635ec39ebb27'
const SUBJECTS = [
  { routeKey: 'USDC → supply on Aave V3', destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', assetDecimals: 6 },
  { routeKey: 'USDe → supply on Aave V3', destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
    asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', assetDecimals: 18 },
]

/** Recorded primary logs, with collection availability distinct from occurrence.
 * Exact dataset hash approves neither current config nor a reconstructed past forecast.
 * Block hashes are absent from this dataset: these facts cannot qualify a holder source. */
export function readAavePrimaryEventFacts(question: RouteEventQuestion, cutoffMs: number) {
  const subject = SUBJECTS.find(s => s.routeKey === question.routeKey && s.destination === question.destination &&
    s.asset === question.payoutAsset && s.assetDecimals === question.assetDecimals)
  const base = { schema: 'route_primary_event_facts_v1' as const, question,
    association: 'primary_facts_not_causal_news_effect' as const,
    version: 'aave_v3_ethereum_core' as const,
    historicalStateOnly: true, currentConfigurationKnown: false,
    scenario: null, scenarioReason: 'no_reviewed_event_NET_assumption' as const,
    holderExecutableExit: false as const, forecastValidated: false as const }
  if (!subject) return { ...base, status: 'subject_not_enrolled' as const, facts: [] }
  try {
    const path = resolve(process.env.MEMBRANE_DATASETS_DIR ?? '/workspace/membrane-datasets',
      'governance-changes/aave-v3-ethereum-core.json')
    const text = readBoundedReceiptFile(path, { maxFileBytes: 300000, maxTotalBytes: 300000, totalBytes: 0 })
    if (createHash('sha256').update(text).digest('hex') !== SHA) throw Error('primary_event_pin')
    const body = JSON.parse(text), available = Date.parse(body.fetchedAt)
    if (!Number.isSafeInteger(cutoffMs) || !Number.isFinite(available) || available > cutoffMs ||
        body.configurator !== CONFIGURATOR || !Array.isArray(body.events) || body.events.length > 5000)
      throw Error('primary_event_availability_or_identity')
    const facts: ReviewedPrimaryEvent[] = body.events.filter((e: any) => e.chainId === 1 &&
      e.address === CONFIGURATOR && e.args?.asset?.toLowerCase() === subject.asset &&
      Number.isSafeInteger(e.block) && Number.isSafeInteger(e.logIndex) && Number.isSafeInteger(e.ts) &&
      e.ts * 1000 <= available && /^0x[0-9a-f]{64}$/.test(e.tx) &&
      typeof e.name === 'string' && /^[A-Za-z0-9_]{1,96}$/.test(e.name))
      .sort((a: any, b: any) => b.ts - a.ts || b.logIndex - a.logIndex).slice(0, 20)
      .map((e: any) => ({ eventId: `${e.tx}:${e.logIndex}`, title: e.name,
        affected: { ...subject, version: 'aave_v3_ethereum_core' },
        primarySource: { kind: 'native_log', url: `https://etherscan.io/tx/${e.tx}#eventlog`,
          contentSha256: SHA, reviewRef: 'governance-changes/manifest.json:aave-v3-ethereum-core.json' },
        occurredAtUtc: new Date(e.ts * 1000).toISOString(), publishedAtUtc: null,
        fetchedAtUtc: body.fetchedAt, availableAtUtc: body.fetchedAt }))
    return { ...base, status: 'recorded_primary_facts' as const, sourceSha256: SHA,
      availableAtUtc: body.fetchedAt, blockHashEvidence: 'not_recorded' as const, facts }
  } catch { return { ...base, status: 'source_unavailable_or_not_yet_available' as const, facts: [] } }
}
