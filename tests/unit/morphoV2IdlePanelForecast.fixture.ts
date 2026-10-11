/** Replay controls use retained native code/scalars with simulated fresh header/read clocks.
 * These fixtures are not new network observations and grant no native or execution authority. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agreeHolderExitCapacityQuotes, type HolderExitCapacityQuote } from '../../lib/carry/holderExitCapacity'
import { MORPHO_V2_IDLE_COMPACT_PANEL_PIN } from '../../lib/carry/morphoV2IdleCompactPanelPin'
import { resolveMorphoV2IdleTrustedProfile } from '../../lib/carry/morphoV2IdleTrustedProfiles'
import { encodeMorphoV2IdlePanelHolderForecastEvidence } from '../../lib/carry/morphoV2IdleCompactPanelEvidence'
import type { MorphoV2IdleCurrentBrowserObservation, MorphoV2IdleNativeBrowserTrace } from '../../lib/carry/morphoV2IdleHolderForecastEvidence'
import type { MorphoV2IdleJointHolderForecastQuestion } from '../../lib/carry/morphoV2IdleJointHolderForecastBinding'

export const PANEL_TEST_SOURCE_MS = Date.parse('2026-10-10T12:00:00.000Z')
export const PANEL_TEST_ISSUE_MS = PANEL_TEST_SOURCE_MS + 5 * 60000
export const PANEL_TEST_HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
export const panelTestAbi = (n: string) => '0x' + BigInt(n).toString(16).padStart(64, '0')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export function panelTestText(): string {
  const pin = MORPHO_V2_IDLE_COMPACT_PANEL_PIN
  if (!pin.relativePath || !pin.sha256 || !pin.bytes) throw Error('parent_verified_compact_pin_required_before_positive_controls')
  const text = readFileSync(resolve(pin.relativePath), 'utf8')
  if (Buffer.byteLength(text) !== pin.bytes || digest(text) !== pin.sha256) throw Error('compact_test_pin_drift')
  return text
}
export function panelForecastFixture(options: { changedStock?: boolean; owner?: string; q?: string; horizonHours?: number; fullEaRaw?: string; idleCashRaw?: string } = {}) {
  const directory = resolve('data/research/venue-signals/pyusd-b576-idle-history-v2-2026-10-10T05-29-29.760Z-b9d9aa95-5eec-4e5d-92af-fd6b4d3d6091')
  const reportText = readFileSync(resolve(directory, 'report.json'), 'utf8')
  if (digest(reportText) !== '09f5619b3f07d62a22bf56fb6732a6b4f0a7c6dc91f0781452372ed8d5cbc136') throw Error('retained_test_source_drift')
  const report = JSON.parse(reportText), captured = report.points[0]
  const traces: MorphoV2IdleNativeBrowserTrace[] = captured.nativeReferences.flatMap((ref: { physicalIds: number[] }) => ref.physicalIds.map(physicalId => {
    const row = JSON.parse(readFileSync(resolve(directory, `native-row-${String(physicalId).padStart(3, '0')}.json`), 'utf8')).row
    const requestText = Buffer.from(row.request.requestBodyBase64, 'base64').toString('utf8'), bodyText = Buffer.from(row.observation.rawBodyBase64, 'base64').toString('utf8')
    if (digest(requestText) !== row.request.requestBodySha256 || digest(bodyText) !== row.observation.bodySha256) throw Error('retained_rpc_body_drift')
    return { host: row.request.host, key: row.request.key, physicalId, request: JSON.parse(requestText), envelope: JSON.parse(bodyText) }
  }))
  const profile = resolveMorphoV2IdleTrustedProfile('PYUSD → VaultV2 [PYUSD]', report.subject.vault, report.subject.asset)!
  const owner = options.owner ?? report.subject.owner, sharesRaw = options.changedStock ? String(BigInt(report.freshCurrentSharesRaw) * 2n) : report.freshCurrentSharesRaw
  const fullEaRaw = options.fullEaRaw ?? (options.changedStock ? '1428001' : '714000')
  const source = { ...report.currentSource, blockTime: new Date(PANEL_TEST_SOURCE_MS).toISOString() }
  for (const t of traces) {
    if (t.key.endsWith(':header_before') || t.key.endsWith(':header_after')) t.envelope.result = { hash: source.blockHash, number: '0x' + BigInt(source.blockNumber).toString(16), timestamp: '0x' + (BigInt(PANEL_TEST_SOURCE_MS) / 1000n).toString(16) }
    if (t.key === 'current:owner_code') t.request.params[0] = owner
    if (t.key === 'current:actual_owner_shares') { (t.request.params[0] as { data: string }).data = '0x70a08231' + owner.slice(2).padStart(64, '0'); t.envelope.result = panelTestAbi(sharesRaw) }
    if (t.key === 'current:fixed_stock_preview') { (t.request.params[0] as { data: string }).data = '0x4cdad506' + BigInt(sharesRaw).toString(16).padStart(64, '0'); t.envelope.result = panelTestAbi(fullEaRaw) }
    if (t.key === 'current:idle_cash' && options.idleCashRaw !== undefined) t.envelope.result = panelTestAbi(options.idleCashRaw)
  }
  const current: MorphoV2IdleCurrentBrowserObservation = { label: 'current', source, owner, probeSharesRaw: sharesRaw, traces, startedAtUtc: new Date(PANEL_TEST_SOURCE_MS + 60000).toISOString(), readAtUtc: new Date(PANEL_TEST_SOURCE_MS + 120000).toISOString() }
  const panelText = panelTestText(), evidence = { schema: 'morpho_v2_idle_holder_forecast_evidence_v2' as const, panelText, current }
  const quote: HolderExitCapacityQuote = { status: 'holder_capacity_quote', scope: 'existing_holder_position', routeKey: profile.identity.routeKey, destination: profile.identity.destination, owner, requestedRaw: options.q ?? '500000', asset: profile.identity.asset, assetDecimals: 6, source: { ...source, blockNumber: Number(source.blockNumber) }, entitlementRaw: fullEaRaw, quotedMaxWithdrawRaw: '0', quotedMaxWithdrawStatus: 'quoted', effectiveLimitRaw: null, withdrawalsPaused: null, sourceHolderPosition: { sharesRaw, shareDecimals: 18, method: 'balance_of_owner_at_source' }, entitlementMethod: 'preview_redeem_full_position', quotedLimitMethod: 'max_withdraw_owner', effectiveLimitMethod: 'unavailable', successfulRequestedRawLowerBound: null, aggregateAccessibleLiquidityRaw: null, hypotheticalDepositCapacityRaw: null, holderExecutableExit: false, futureCapacityValidated: false, forecastValidated: false, prospectiveValidated: false, minedPayoutObserved: false }
  const capacity = agreeHolderExitCapacityQuotes({ host: PANEL_TEST_HOSTS[0], quote }, { host: PANEL_TEST_HOSTS[1], quote: structuredClone(quote) }, PANEL_TEST_ISSUE_MS)!
  const question: MorphoV2IdleJointHolderForecastQuestion = { routeKey: profile.identity.routeKey, destination: profile.identity.destination, requestedRaw: quote.requestedRaw, requestedAssetAddress: quote.asset, requestedAssetDecimals: 6, requestedHolderAddress: owner, horizonHours: options.horizonHours ?? 4, asOfMs: PANEL_TEST_ISSUE_MS, independentSource: quote.source }
  const expectation = { profile, owner, source, sharesRaw, fullEaRaw, asOfMs: PANEL_TEST_ISSUE_MS }
  const request = { routeKey: quote.routeKey, destination: quote.destination, owner, requestedRaw: quote.requestedRaw, asset: quote.asset, assetDecimals: quote.assetDecimals, source: quote.source }
  const text = encodeMorphoV2IdlePanelHolderForecastEvidence(evidence)
  if (!text) throw Error('fixture_wire_shape')
  return { profile, panelText, evidence, current, capacity, question, expectation, request, text }
}
