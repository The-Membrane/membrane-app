import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants, openSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  readSync, statfsSync, writeFileSync, type Stats,
} from 'node:fs'
import { basename, join } from 'node:path'
import { encodeFunctionData, parseAbi } from 'viem'

import handler from '@/pages/api/carry/holder-exit-assessment'
import { holderTimeProcessIssueFromResponse } from '@/components/Carry/ForecastWorkbench'
import { ExitPressureCard, formatExitPressureRaw, formatExitPressureSignedRaw } from '@/components/Carry/ExitPressureCard'
import { selectedMorphoV2JointHolderForecastFromIssue } from '@/lib/carry/morphoV2JointHolderForecastBinding'
import { prewarmMorphoV2ProtocolHistory } from '@/lib/carry/morphoV2CurrentProtocolCapacityEvidence'
import { resolveMorphoV2TrustedProfile } from '@/lib/carry/morphoV2TrustedProfiles'
import { reviewedMorphoV2ProtocolHistory } from '@/lib/carry/morphoV2ReviewedProtocolHistories'
import { decodeMorphoV2ProtocolEvidencePair } from '@/lib/carry/morphoV2ProtocolEvidenceCodec'
import { decodeMorphoV2HolderPositionEvidence, decodeMorphoHolderPositionUint } from '@/lib/carry/morphoV2HolderPositionEvidence'
import {
  decodeMorphoV2HistoricalHolderEaEvidencePair, decodeMorphoV2HistoricalHolderEaUint,
  morphoV2HistoricalHolderEaCalldata,
} from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'

// Root runs one live request with an external 90s job cap and 384 MiB old-space cap.
// Retained Fluid pattern: real handler -> clean JSON -> actual Workbench -> original receipt -> Card SSR.
// No RPC mocks, native overrides, fake clocks, provider edits, HTTP server or browser.
const ROOT = '/Users/EBmic/membrane-app'
const SELF = join(ROOT, 'scripts/research/eurcv-holder-default-live-acceptance.test.tsx')
const CONFIG = join(ROOT, 'scripts/research/eurcv-holder-default-live-acceptance.test.cjs')
const ROUTE = 'EURCV → VaultV2 [EURCV]', VAULT = '0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f'
const OWNER = '0x50461744cb3dea4d678be82b8f1b9cead383065d', ASSET = '0x5f7827fdeb7c20b443265fc2f40845b715385ff2'
const Q = '1000000000000000000', H = 1
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const FILE = 8 * 1024 * 1024, TOTAL = 32 * 1024 * 1024, SOURCE = 6 * 1024 * 1024
const PRE = 288 * 1024 * 1024, RESERVE = 256 * 1024 * 1024, TAIL = 256 * 1024
const QUALIFICATION_MS = 85_000 // Leave five seconds under the parent cap for failure retention.
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
// Selected-path fixed pins include the unchanged production owner-code guard and provider-policy source.
// This is an explicit code snapshot, not the entire UI dependency graph or archive-original closure.
const SOURCE_PINS = [
  {"path":"components/Carry/ExitPressureCard.tsx","bytes":231167,"sha256":"a7fc86e499c8a779d680ab89fbccd49d61f14c8474b207cdcf06a5cef46d52bc"},
  {"path":"components/Carry/ForecastWorkbench.tsx","bytes":353824,"sha256":"138b5d941e25cea98223795d3f327b063947d814eb42a986ee49317283932e19"},
  {"path":"data/research/venue-signals/morpho-usdt-reviewed-protocol-history-2026-10-08.frame.json","bytes":23423,"sha256":"098cac9ed3b7b766019cd8bfba24ace3b7f515b4f151b328eba48523f1749b1a"},
  {"path":"db/index.ts","bytes":1532,"sha256":"9bf667794c756168cbe62f9f9167ac83ca614f42691400b79c19796b55489f9d"},
  {"path":"lib/carry/holderExitAssessment.ts","bytes":59088,"sha256":"31f2ff8ff5000a308f39c79f1cd67f7041dd281f24fb6622993081bb6980a34c"},
  {"path":"lib/carry/holderExitCapacity.ts","bytes":27799,"sha256":"a63187a618dba435f11b9d348ec19b7646c2bd3cc47582903ef0a09d6ec0f186"},
  {"path":"lib/carry/holderExitMechanisms.ts","bytes":19949,"sha256":"261adb8f7cd7a9e922f6c45608f008861d223c4cd747ef6b7b94f644957b9282"},
  {"path":"lib/carry/holderExitSubjectRegistry.ts","bytes":9625,"sha256":"db3520c5fc8ac04d86736c5eb41c4a71477f550a23d343dff38d5c5fb4d6ae85"},
  {"path":"lib/carry/holderOriginCode.ts","bytes":378,"sha256":"1c517d20fe25ea8d64aac341f82e69f60f04424cccbb56dc3228403859328bf9"},
  {"path":"lib/carry/morpho-v2-asset-identities.json","bytes":21809,"sha256":"8dd54bbb3dea0842bb67e582f0725adcafb7594107933122c5fa381c083566da"},
  {"path":"lib/carry/morphoExitQuote.ts","bytes":16168,"sha256":"21098c928c644fb9755c077932b132e7e8b8c718684f1e61c4e44ca3f3c1063d"},
  {"path":"lib/carry/morphoNativeEventCashAdapter.server.ts","bytes":42889,"sha256":"cdde3c0e86872b59e968d9f5e5844528cd51dc897b26f3cbff846534914fb342"},
  {"path":"lib/carry/morphoV2AdapterCapacityMath.ts","bytes":4400,"sha256":"93cba3a720513bf6145d19d7122f85abb6e91d9b61ecac2e80eb386c83d52abb"},
  {"path":"lib/carry/morphoV2CurrentProtocolCapacityEvidence.ts","bytes":12047,"sha256":"db2dfeda60a450e86a8c0490fcd5fb6dc99610141b6c484e2aec8fb62d3c34c7"},
  {"path":"lib/carry/morphoV2HistoricalHolderEaEvidence.ts","bytes":19262,"sha256":"1fa449298dcc9d487283d3e9abd63e5d424d14c20498442108a221a5daa9a6de"},
  {"path":"lib/carry/morphoV2HistoricalHolderEaReader.server.ts","bytes":5131,"sha256":"7be1aa23c748850e90fd81d076baf38b7840c13e6e414a8bbacefbfb3e71abb4"},
  {"path":"lib/carry/morphoV2HolderForecastBinding.ts","bytes":6899,"sha256":"61d1473063b07b6ce653e785188d4156ae5ed42cc4d0f0a735e92f4726e82de6"},
  {"path":"lib/carry/morphoV2HolderPositionEvidence.ts","bytes":15306,"sha256":"0677822500bd2e83d36a6c7ddaaf3f5749c7d4cc85fb92d7f30b6a31d245c8fa"},
  {"path":"lib/carry/morphoV2HolderTimeProcess.ts","bytes":12921,"sha256":"39caccdcebef27c0baa00500629ccaa95b85656e0dc34914882d51d2d80c2fa7"},
  {"path":"lib/carry/morphoV2JointHolderForecastBinding.ts","bytes":19571,"sha256":"327c2ca6b44ef265c521766e8be33d7c21e6d86d7d241f1032db18047e560176"},
  {"path":"lib/carry/morphoV2JointStockProjection.ts","bytes":19046,"sha256":"3c11964daaee3c8b6cf92bfb74f298dc5d428129ff7191fb29be6bb88827cfbf"},
  {"path":"lib/carry/morphoV2MultiAssetObservedHistory.server.ts","bytes":19874,"sha256":"03d58781655b0686c5e373284173aa3ac7ed3b3891800b6376f993b657308942"},
  {"path":"lib/carry/morphoV2PilotHistoricalEvidence.ts","bytes":5890,"sha256":"b9f1e9f5ce6b498935e46f45ad212d868df5893e9bbe7ccc1cda8dca9bfdf8c8"},
  {"path":"lib/carry/morphoV2ProtocolCapacityHistoryPins.ts","bytes":2260,"sha256":"382d4ef7f4d3cd732ab387281caa9af3f777066c5f29a3c14036f39144cb704b"},
  {"path":"lib/carry/morphoV2ProtocolCapacityReplay.ts","bytes":21806,"sha256":"9974889a25c2a5962fddd625457dbd81315ed3e339c06169c0f59fad649bb594"},
  {"path":"lib/carry/morphoV2ProtocolEvidenceCodec.ts","bytes":8670,"sha256":"99c68ecb25e690cddb52354cb32313f945db9e7c1e3cae1db647c2a96c0c6abe"},
  {"path":"lib/carry/morphoV2ReviewedProtocolHistories.ts","bytes":26295,"sha256":"7a0a11eac4cdb19aeab6f245839b1a456536da78aff205f30c2b8a228042f835"},
  {"path":"lib/carry/morphoV2TrustedProfiles.ts","bytes":22382,"sha256":"c0fbc5f2f3d3cdbd7bbc94edc0650c9435e61d49bb7e5fbfe6a28fd19cc272db"},
  {"path":"lib/carry/morphoVaultCapacityProjection.ts","bytes":9934,"sha256":"3cbcf466bce9f9dece080ff2c77fe859b2b2bd2537dd00d968ddc9db2a66f889"},
  {"path":"lib/carry/other-vault-asset-identities.json","bytes":4897,"sha256":"a77505b23b275759cce4ad12aea2e22f9a8b0e7595393d5b478055cbf8cc6119"},
  {"path":"lib/carry/trackedDirectVaultExit.ts","bytes":18751,"sha256":"63d3d273c2b495bb4927a1b1a4feb972752a7b9abacf4a458bb346011821c3ae"},
  {"path":"lib/game/rateLimit.ts","bytes":4163,"sha256":"0e54127e5cf3b2e8c4b6921b7bcda9350e4b3c5cdefc79483ae425057bc6f6e7"},
  {"path":"package.json","bytes":5057,"sha256":"d5186c257808af86990aae2565544129aed085322a11e1be771cb132c1ede475"},
  {"path":"pages/api/carry/holder-exit-assessment.ts","bytes":83477,"sha256":"c141494efc692729b5f63a45c5b20885554131450b1d31c273f23ae67570fe9f"},
  {"path":"pnpm-lock.yaml","bytes":814546,"sha256":"0b09f1f56caa8810a0874c66d5751fdb9ab4edf2153e25d60c82da07da1cf23a"},
  {"path":"scripts/research/carry-depth-quote-archive.mjs","bytes":56802,"sha256":"cff300ba5014a24955f126d7e949f2d3f45778e21e36bbcd20ab06e45cf4fd16"},
  {"path":"scripts/research/carry-depth-quote-provider-policy.json","bytes":556,"sha256":"47080961e761b920c7aca196f9048c9f2dbc0ecacce4447bcaf1a7c8e3283197"},
  {"path":"scripts/route-rates/exact-leg-spread.mjs","bytes":9833,"sha256":"764b829730503eae7857cbc5fb83fde8326930c1204713e0c2d61cd2eb2b9467"}
] as const
const REFERENCES = [
  {
    "path": "data/research/venue-signals/fluid-usdt-cash-boundary-live-2026-10-09-35a4f41d-0211-4683-a3b7-18a3aa4d1757/source-22-cash-boundary-default-live-8809e15b-c8b2-467d-bdcb-6f2b509b6365.test.tsx",
    "bytes": 20149,
    "sha256": "6fccac16b5cae4ba772a0fdfdc44a59bd6166c8f17af9e5f0d9c6993f850a04b"
  },
  {
    "path": "data/research/venue-signals/fluid-usdt-cash-boundary-live-2026-10-09-35a4f41d-0211-4683-a3b7-18a3aa4d1757/source-23-cash-boundary-default-live-8809e15b-c8b2-467d-bdcb-6f2b509b6365.test.cjs",
    "bytes": 562,
    "sha256": "23010823a89bd887a6665180c4ece684f66dd290a79c58310664252c04f92c3f"
  }
] as const
const nativeNow = Date.now, NativeDate = Date, nativeFetch = globalThis.fetch, nativePerformanceNow = performance.now
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
function check(v: unknown, reason: string): asserts v { if (!v) throw Error('eurcv_acceptance_' + reason) }
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function sanitized(error: unknown): string {
  return error instanceof Error && /^eurcv_acceptance_[a-z0-9_]+$/.test(error.message)
    ? error.message : 'eurcv_acceptance_unknown_failure'
}
function freeBytes() { const s = statfsSync(ROOT); return Number(s.bavail) * Number(s.bsize) }
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function sameIdentity(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs && b.isFile() && !b.isSymbolicLink() && b.nlink === 1
}
function readExact(path: string, privateFile = false): Buffer {
  const named = lstatSync(path)
  check(named.isFile() && !named.isSymbolicLink() && named.nlink === 1 &&
    Number.isSafeInteger(named.size) && named.size >= 0 && named.size <= FILE, 'input_file')
  if (privateFile) check((named.mode & 0o777) === 0o600, 'private_file_mode')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const start = fstatSync(fd); check(sameIdentity(named, start), 'input_identity')
    const b = Buffer.alloc(start.size); let offset = 0
    while (offset < b.length) { const n = readSync(fd, b, offset, b.length - offset, null); check(n > 0, 'input_short_read'); offset += n }
    check(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0, 'input_growth')
    const end = fstatSync(fd), final = lstatSync(path)
    check(sameIdentity(start, end) && sameIdentity(end, final), 'input_drift')
    if (privateFile) check((end.mode & 0o777) === 0o600 && (final.mode & 0o777) === 0o600, 'private_file_mode')
    return b
  } finally { closeSync(fd) }
}
type Descriptor = { name: string; bytes: number; sha256: string }
type Attempt = { name: string; chargedBytes: number; status: 'opened' | 'retained' | 'failed'; reason?: string }

it('one real EURCV default API -> JSON -> Workbench original joint receipt -> Card SSR', async () => {
  const started = nativeNow(), mono = performance.now()
  let phase = 'preflight', directory = '', directoryIdentity: Stats | null = null
  let statusCode = 0, accounted = 0, requestCalls = 0, terminalRetained = false
  const files: Descriptor[] = [], attempts: Attempt[] = []
  const inspection: Record<string, unknown> = {
    schema: 'eurcv_holder_default_api_workbench_card_ssr_live_acceptance_v1',
    scope: 'real_default_handler_clean_JSON_actual_Workbench_original_receipt_Card_SSR',
    initialAtUtc: new NativeDate(started).toISOString(), routeKey: ROUTE, destination: VAULT, owner: OWNER,
    asset: ASSET, requestedRaw: Q, horizonHours: H, assetDecimals: 18, shareDecimals: 18,
    SDKphysicalStarts: null, SDKreadCountStatus: 'unmeasured', separateDiscoveryPhysicalStarts: 0,
    nativeProtocolLimitPerOrigin: { calls: 31, deadlineMs: 8000 },
    nativeHistoricalActualSLimitPerOrigin: { calls: 8, deadlineMs: 12000 },
    HTTP: false, browser: false, originalAuthority: false, authenticated: false, executionQualified: false,
    calibrated: false, sourceImplementationEquivalence: false, historicalOwnership: false,
    walletControl: false, coveragePromotion: false, MRaw: null,
    ownerCodeGuard: 'unchanged_production_reader_no_bypass', fundedDiscoveryReadOwnerCode: false,
    separatelyCapturedOwnerCode: false, APIRejectionCause: 'sanitized_response_only_no_inferred_EOA_rejection',
    limits: { perFileBytes: FILE, totalBytes: TOTAL, sourceBytes: SOURCE, prejobFreeBytes: PRE,
      retainedReserveBytes: RESERVE, qualificationMs: QUALIFICATION_MS, parentExternalMs: 90000,
      parentRequiredMaxOldSpaceMiB: 384, heapCapEnforcement: 'parent_process' },
  }
  function before(nextPhase: string) {
    phase = nextPhase
    check(Date.now === nativeNow && Date === NativeDate && globalThis.fetch === nativeFetch && performance.now === nativePerformanceNow, 'native_globals_changed')
    const elapsed = performance.now() - mono, wallElapsed = nativeNow() - started
    check(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= QUALIFICATION_MS && wallElapsed >= 0 && wallElapsed <= QUALIFICATION_MS, 'deadline')
    check(freeBytes() >= RESERVE, 'reserve')
  }
  function verifyDirectory() {
    check(directoryIdentity && directory.startsWith('/private/tmp/eurcv-holder-default-live-'), 'output_parent')
    const d = lstatSync(directory)
    check(d.isDirectory() && !d.isSymbolicLink() && (d.mode & 0o777) === 0o700 &&
      d.ino === directoryIdentity.ino && d.dev === directoryIdentity.dev, 'private_directory_identity')
  }
  function save(name: string, b: Buffer, tail = false, failureRetention = false) {
    check(basename(name) === name && /^[a-zA-Z0-9_.-]+$/.test(name) && b.length <= FILE, 'output_file')
    check((tail ? b.length <= TAIL / 2 : accounted + b.length + TAIL <= TOTAL) && accounted + b.length <= TOTAL, 'output_cap')
    if (!failureRetention) before(phase)
    verifyDirectory()
    // 288 MiB is the acquisition preflight; ongoing writes preserve 256 MiB plus their reserved failure tail.
    check(freeBytes() - b.length - (tail ? 0 : TAIL) >= RESERVE, 'output_reserve')
    const path = join(directory, name)
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    accounted += b.length // Charge every opened attempt before write/fsync, including failed attempts.
    const attempt: Attempt = { name, chargedBytes: b.length, status: 'opened' }; attempts.push(attempt)
    try {
      try {
        writeFileSync(fd, b); fsyncSync(fd)
        const a = fstatSync(fd), n = lstatSync(path)
        check(a.size === b.length && sameIdentity(a, n) && (a.mode & 0o777) === 0o600 && (n.mode & 0o777) === 0o600, 'output_identity')
      } finally { closeSync(fd) }
      syncDirectory(directory); verifyDirectory()
      const readback = readExact(path, true); check(readback.equals(b) && sha(readback) === sha(b), 'output_readback')
      if (!failureRetention) before(phase)
      files.push({ name, bytes: b.length, sha256: sha(readback) }); attempt.status = 'retained'
    } catch (error) { attempt.status = 'failed'; attempt.reason = sanitized(error); throw error }
  }
  function json(name: string, value: unknown, tail = false, failureRetention = false) {
    save(name, Buffer.from(JSON.stringify(value) + '\n'), tail, failureRetention)
  }
  const runtimePins: { path: string; bytes: number; sha256: string }[] = []
  function unchanged() {
    for (const pin of runtimePins) { const b = readExact(pin.path); check(b.length === pin.bytes && sha(b) === pin.sha256, 'source_drift') }
  }
  try {
    before('source_snapshot'); check(freeBytes() >= PRE, 'prejob_reserve')
    const copies = SOURCE_PINS.map(pin => {
      const path = join(ROOT, pin.path), bytes = readExact(path)
      check(bytes.length === pin.bytes && sha(bytes) === pin.sha256, 'fixed_source_drift'); return { path, bytes }
    }).concat([SELF, CONFIG].map(path => ({ path, bytes: readExact(path) })))
    check(copies.reduce((n, p) => n + p.bytes.length, 0) <= SOURCE, 'source_closure_6mib')
    for (const p of copies) runtimePins.push({ path: p.path, bytes: p.bytes.length, sha256: sha(p.bytes) })
    const referencePins = REFERENCES.map(pin => {
      const b = readExact(join(ROOT, pin.path)); check(b.length === pin.bytes && sha(b) === pin.sha256, 'retained_reference_drift'); return pin
    })
    directory = '/private/tmp/eurcv-holder-default-live-' + new NativeDate(started).toISOString().replaceAll(':', '-') + '-' + randomUUID()
    mkdirSync(directory, { mode: 0o700 }); syncDirectory('/private/tmp'); directoryIdentity = lstatSync(directory); verifyDirectory()
    copies.forEach((p, i) => save('source-' + String(i).padStart(2, '0') + '-' + basename(p.path), p.bytes))
    json('source-snapshot.json', { schema: 'eurcv_default_live_selected_path_sources_v1',
      scope: 'selected_Morpho_producer_consumer_sources_not_exhaustive_UI_dependency_or_raw_archive_closure',
      pins: runtimePins, sourceBytes: copies.reduce((n, p) => n + p.bytes.length, 0), retainedHarnessReferences: referencePins })
    before('disk_history_prewarm')
    const profile = resolveMorphoV2TrustedProfile(ROUTE, VAULT, ASSET)
    check(profile && profile.id === 'morpho_v2_eurcv_observed_protocol_history', 'trusted_profile')
    check(await prewarmMorphoV2ProtocolHistory(profile), 'disk_history_prewarm')
    const history = reviewedMorphoV2ProtocolHistory(profile); check(history && history.history.points.length >= 2, 'reviewed_history')
    json('reviewed-history.json', { profileId: profile.id, history, scope: 'existing_pinned_disk_history_no_new_RPC_or_past_ownership' })
    before('default_handler_request'); unchanged()
    const input = { chainId: 1, routeKey: ROUTE, destinationAddress: VAULT, owner: OWNER, assetsRaw: Q, horizonHours: H }
    check(!Object.hasOwn(input, 'sharesRaw') && requestCalls === 0, 'one_request_without_shares_raw')
    json('request.json', { input, transport: 'direct_production_handler_no_HTTP', SAndEaSource: 'native_balanceOf_owner_and_previewRedeem_full_S_not_Q' })
    const headers: Record<string, string> = {}; let handlerValue: unknown, responseCalls = 0
    const response = {
      status(code: number) { statusCode = code; return this },
      json(value: unknown) { responseCalls++; handlerValue = value; return this },
      setHeader(key: string, value: string | string[]) { headers[key] = String(value); return this },
    }
    before('native_acquisition_preflight'); check(freeBytes() >= PRE, 'pre_acquisition_288mib')
    const requestedAtMs = nativeNow(); requestCalls++
    // Preserve the original owner-code guard. One real attempt; no fallback caller or native transport.
    await handler({ method: 'POST', body: input, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never, response as never)
    const receivedAtMs = nativeNow(), wire = JSON.stringify(handlerValue ?? null)
    // Retain actual failed wire data before status, EOA, evidence or model-admission checks.
    phase = 'response_retention'
    save('response-wire.json', Buffer.from(wire + '\n'), false, true)
    json('response-clocks.json', { requestedAtMs, receivedAtMs, requestedAtUtc: new NativeDate(requestedAtMs).toISOString(),
      receivedAtUtc: new NativeDate(receivedAtMs).toISOString(), statusCode, responseCalls, requestCalls, headers, SDKphysicalStarts: null }, false, true)
    Object.assign(inspection, { requestedAtUtc: new NativeDate(requestedAtMs).toISOString(), receivedAtUtc: new NativeDate(receivedAtMs).toISOString(), statusCode, responseCalls, requestCalls })
    before('response_admission'); check(responseCalls === 1 && requestCalls === 1, 'one_response')
    const clean: unknown = JSON.parse(wire); check(record(clean), 'response_record')
    inspection.responseError = typeof clean.error === 'string' && /^[a-z0-9_]{1,96}$/.test(clean.error) ? clean.error : null
    check(statusCode === 200 || (statusCode === 503 && clean.error === 'holder_exit_assessment_unavailable'), 'response_status')
    check(record(clean.capacityAgreement) && record(clean.capacityAgreement.quote), 'capacity_transport_missing')
    const quote = clean.capacityAgreement.quote; check(record(quote.source), 'native_source_missing'); const source = quote.source
    check(source.chainId === 1 && source.finalized === true && typeof source.blockNumber === 'number' && Number.isSafeInteger(source.blockNumber) && source.blockNumber > 0 &&
      typeof source.blockHash === 'string' && /^0x[0-9a-f]{64}$/.test(source.blockHash) && typeof source.blockTime === 'string' &&
      new NativeDate(source.blockTime).toISOString() === source.blockTime && receivedAtMs >= Date.parse(source.blockTime) &&
      receivedAtMs - Date.parse(source.blockTime) <= 1800000, 'native_source_ttl')
    inspection.source = source
    const protocol = decodeMorphoV2ProtocolEvidencePair(clean.morphoV2CurrentProtocolCapacityEvidence)
    check(protocol && typeof clean.morphoV2CurrentHolderPositionEvidence === 'string' && typeof clean.morphoV2HistoricalHolderEaEvidence === 'string', 'joint_transport_missing')
    const holder = decodeMorphoV2HolderPositionEvidence(clean.morphoV2CurrentHolderPositionEvidence)
    const historical = decodeMorphoV2HistoricalHolderEaEvidencePair(clean.morphoV2HistoricalHolderEaEvidence); check(historical, 'historical_full_s_transport')
    before('Workbench_original_issue')
    // Match real Workbench issuance at receivedAtMs. No independent forecastSourceReference was requested.
    const question = { routeKey: ROUTE, destination: VAULT, requestedHolderAddress: OWNER, requestedRaw: Q,
      requestedAssetAddress: ASSET, requestedAssetDecimals: 18, horizonHours: H, asOfMs: receivedAtMs }
    const issue = holderTimeProcessIssueFromResponse(clean, statusCode, question, null, null, null)
    json('original-issue.json', { question, issue, separatelyObservedSource: null, scope: 'serialized_receipt_cannot_restore_private_original_identity' })
    check(issue, 'original_joint_issue_missing')
    const model = selectedMorphoV2JointHolderForecastFromIssue(issue, question, nativeNow())
    json('selected-model.json', { question, model }) // Preserve a null/mismatched selection before asserting acceptance.
    check(model && model.status === 'conditional_morpho_v2_joint_holder_forecast', 'original_joint_model_missing')
    check(model.source.chainId === source.chainId && model.source.blockNumber === source.blockNumber &&
      model.source.blockHash === source.blockHash && model.source.blockTime === source.blockTime &&
      model.source.finalized === source.finalized, 'model_native_source_join')
    check(model.profileId === profile.id && model.owner === OWNER && model.asset === ASSET && model.assetDecimals === 18 && model.shareDecimals === 18 &&
      model.requestedRaw === Q && model.horizonHours === H && model.input.asOfMs === receivedAtMs && model.input.horizonHours === H &&
      model.issueAtUtc === new NativeDate(receivedAtMs).toISOString() && model.targetAtUtc === new NativeDate(receivedAtMs + 3600000).toISOString() &&
      record(issue) && issue.issuedAtMs === receivedAtMs && issue.sharesRaw === model.sharesRaw && issue.fullEaRaw === model.fullEaRaw &&
      issue.owner === OWNER && issue.requestedRaw === Q && issue.profileId === profile.id, 'original_binding')
    check(BigInt(model.sharesRaw) > 0n && BigInt(model.fullEaRaw) > 0n && model.sharesRaw !== Q && model.fullEaRaw !== Q &&
      quote.entitlementMethod === 'preview_redeem_full_position' && quote.entitlementRaw === model.fullEaRaw && record(quote.sourceHolderPosition) &&
      quote.sourceHolderPosition.method === 'balance_of_owner_at_source' && quote.sourceHolderPosition.sharesRaw === model.sharesRaw, 'native_full_s_ea_not_q')
    for (const pair of [protocol, holder, historical]) check(pair.origins.length === 2 && pair.origins.every((o, i) => o.host === HOSTS[i]), 'origin_pair')
    const balanceData = encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [OWNER] }), redeemData = morphoV2HistoricalHolderEaCalldata(model.sharesRaw)
    for (const { observation: o } of holder.origins) {
      const balance = o.traces[0], redeem = o.traces[1]
      check(o.source.blockHash === source.blockHash && o.source.blockNumber === source.blockNumber && o.source.blockTime === source.blockTime && o.destination === VAULT && o.asset === ASSET &&
        balance.key === 'balanceOf' && redeem.key === 'previewRedeem' && balance.params[0].to === VAULT && balance.params[0].data === balanceData &&
        redeem.params[0].to === VAULT && redeem.params[0].data === redeemData && balance.params[1].blockHash === source.blockHash && balance.params[1].requireCanonical === true &&
        redeem.params[1].blockHash === source.blockHash && redeem.params[1].requireCanonical === true &&
        decodeMorphoHolderPositionUint('balanceOf', balance.result).toString() === model.sharesRaw && decodeMorphoHolderPositionUint('previewRedeem', redeem.result).toString() === model.fullEaRaw,
      'paired_native_full_s_ea')
    }
    for (const { observation: o } of protocol.origins) check(o.source.chainId === source.chainId &&
      o.source.blockNumber === source.blockNumber && o.source.blockHash === source.blockHash &&
      o.source.blockTime === source.blockTime && o.source.finalized === true &&
      o.traces.length > 0 && o.traces.length <= 31 && o.deadlineMs <= 8000, 'native_protocol_source_and_bound')
    for (const { observation: o } of historical.origins) {
      check(o.profileId === profile.id && o.sharesRaw === model.sharesRaw && o.currentSource.blockHash === source.blockHash && o.traces.length >= 2 && o.traces.length <= 8 && o.deadlineMs <= 12000, 'native_historical_actual_s_bound')
      for (const trace of o.traces) check(trace.params[0].to === VAULT && trace.params[0].data === redeemData && trace.params[1].blockHash === trace.source.blockHash &&
        trace.params[1].requireCanonical === true && BigInt(trace.source.blockNumber) < BigInt(source.blockNumber) && Date.parse(trace.source.blockTime) < Date.parse(source.blockTime) &&
        decodeMorphoV2HistoricalHolderEaUint(trace.result) >= 0n, 'historical_same_s_not_past_ownership')
    }
    const p = model.process, sourceAgeMs = receivedAtMs - Date.parse(model.source.blockTime)
    check(p.fixedSharesRaw === model.sharesRaw && p.requestedRaw === Q && p.horizonMs === 3600000 && (p.sourceAgeMs ?? 0) === sourceAgeMs &&
      (p.projectionElapsedMs ?? p.horizonMs) === sourceAgeMs + 3600000 && p.sourceSnapshot.fixedShareEntitlement.sharesRaw === model.sharesRaw &&
      p.sourceSnapshot.fixedShareEntitlement.assetsRaw === model.fullEaRaw && p.sourceNormalizedStocks.fullEa === model.fullEaRaw && p.queuedCompetingMRaw === null &&
      p.claims.fullEaDerivedFromRequestedQ === false && model.historicalPastOwnershipProven === false && model.historicalEaMethod === 'native_current_full_S_historical_quotes' &&
      model.authenticated === false && model.holderExecutableExit === false && model.forecastValidated === false && model.prospectiveValidated === false &&
      model.calibratedProbability === false && model.sourceImplementationEquivalence === false, 'projection_binding_age_m_authority')
    function oneQ(m: { protocolCapacityRaw: string; fullEaRaw: string; availableRaw: string; headroomRaw: string }) {
      const ea = BigInt(m.fullEaRaw), c = BigInt(m.protocolCapacityRaw), available = ea < c ? ea : c
      check(BigInt(m.availableRaw) === available && BigInt(m.headroomRaw) === (available > BigInt(Q) ? available - BigInt(Q) : 0n), 'requested_q_once')
    }
    oneQ(p.persistenceBaseline)
    for (const s of p.scenarios) if (s.status === 'usable') {
      oneQ(s.measurement)
      for (const point of s.sampledDuration?.checkpoints ?? []) check(BigInt(point.headroomRaw) === (BigInt(point.availableRaw) > BigInt(Q) ? BigInt(point.availableRaw) - BigInt(Q) : 0n), 'checkpoint_q_once')
    }
    check(model.attemptedDonorCount > 0 && p.scenarios.length + p.excludedDonors.length === model.attemptedDonorCount, 'complete_donor_accounting')
    const clonedIssue = structuredClone(issue)
    check(selectedMorphoV2JointHolderForecastFromIssue(clonedIssue, question, nativeNow()) === null &&
      selectedMorphoV2JointHolderForecastFromIssue(JSON.parse(JSON.stringify(issue)), question, nativeNow()) === null, 'serialized_or_cloned_receipt_denied')
    before('Card_original_receipt_SSR'); const renderAtMs = nativeNow()
    const renderCard = (receipt: typeof issue) => renderToStaticMarkup(<ChakraProvider><ExitPressureCard
      routeKey={ROUTE} destination={VAULT} requestedAmount="1" requestedRaw={Q} requestedAssetSymbol="EURCV"
      requestedAssetAddress={ASSET} requestedAssetDecimals={18} requestedHolderAddress={OWNER} horizonHours={H}
      asOfMs={renderAtMs} currentCash={null} prospectiveCashModel={null} historicalScenario={null}
      grossWithdrawals={null} grossInflows={null} historicalGrossFlow={null} morphoPayout={null} holderAssessment={null}
      expectedEventEnrollment={null} eventContext={null} historicalOutlook={null} holderTimeProcessIssue={receipt} /></ChakraProvider>)
    const fullHtml = renderCard(issue), cloneHtml = renderCard(clonedIssue)
    save('card-original.html', Buffer.from(fullHtml)); save('card-clone-denied.html', Buffer.from(cloneHtml))
    const html = fullHtml.replaceAll(/<style[\s\S]*?<\/style>/g, ''), cloneVisible = cloneHtml.replaceAll(/<style[\s\S]*?<\/style>/g, '')
    const label = 'aria-label="Selected-horizon joint Morpho holder headroom"'
    check(html.includes(label) && !cloneVisible.includes(label), 'card_requires_original_joint_receipt')
    const summary = p.descriptiveExpectedFlow.headline?.headroom
    const counts = `USABLE ${p.usableScenarioCount}/${model.attemptedDonorCount} · CENSORED ${p.descriptiveExpectedFlow.censoredScenarioCount} · EXCLUDED ${p.excludedDonors.length}`
    const fullPosition = `S ${formatExitPressureRaw(model.sharesRaw, 18)} · Ea ${formatExitPressureRaw(model.fullEaRaw, 18)} EURCV · M ?`
    check(html.includes(counts) && html.includes(fullPosition) && html.includes(model.targetAtUtc.slice(5, 19).replace('T', ' ') + ' UTC'), 'card_actual_position_counts_target')
    if (summary) check(p.descriptiveExpectedFlow.censoredScenarioCount === 0 && p.excludedDonors.length === 0 &&
      html.includes(formatExitPressureSignedRaw(summary.empiricalMean.floorRaw, 18) + ' EURCV') &&
      html.includes('MIN–MAX ' + formatExitPressureSignedRaw(summary.band.minRaw, 18) + '–' + formatExitPressureSignedRaw(summary.band.maxRaw, 18) + ' EURCV'), 'card_exact_numeric_headroom')
    else check(html.includes('MIN–MAX —'), 'card_censored_headroom')
    before('final_binding'); unchanged()
    check(selectedMorphoV2JointHolderForecastFromIssue(issue, question, nativeNow()) === model, 'final_original_selection')
    Object.assign(inspection, { source: model.source, originalIssueAtUtc: model.issueAtUtc, targetAtUtc: model.targetAtUtc,
      renderAtUtc: new NativeDate(renderAtMs).toISOString(), sharesRaw: model.sharesRaw, fullEaRaw: model.fullEaRaw,
      originalPrivateReceiptSelected: true, clonedAndJSONReceiptDenied: true, CardCloneMetricDenied: true,
      nativeFullSAndEaPaired: true, historicalQuotesUseActualFullS: true, sourceAgeMs, projectionElapsedMs: sourceAgeMs + 3600000,
      requestedQSubtractedOnce: true, numericHeadlineShown: Boolean(summary), attemptedDonors: model.attemptedDonorCount,
      usableDonors: p.usableScenarioCount, censoredDonors: p.descriptiveExpectedFlow.censoredScenarioCount, excludedDonors: p.excludedDonors.length,
      retainedTraceRows: { currentProtocol: protocol.origins.map(o => o.observation.traces.length), currentHolder: holder.origins.map(o => o.observation.traces.length), historicalFullS: historical.origins.map(o => o.observation.traces.length) },
      traceRowsAreNotInstrumentedPhysicalStarts: true })
    json('inspection.json', inspection); before('terminal_qualification'); unchanged()
    const qualifiedAtUtc = new NativeDate(nativeNow()).toISOString()
    json('terminal.json', { ...inspection, complete: true, accepted: true, phase, qualifiedAtUtc,
      qualificationBoundary: 'before_terminal_fsync_readback_final_deadline', postRetentionAvailableAtUtc: null,
      metadataSelfExcluded: true, accountedBytesBeforeTerminal: accounted, files: [...files], attempts: [...attempts] }, true)
    terminalRetained = true; before('post_terminal_retention')
    check(selectedMorphoV2JointHolderForecastFromIssue(issue, question, nativeNow()) === model, 'post_terminal_original_selection')
    for (const descriptor of files) {
      const retained = readExact(join(directory, descriptor.name), true)
      check(retained.length === descriptor.bytes && sha(retained) === descriptor.sha256, 'post_retention_file_integrity')
    }
    for (const pin of REFERENCES) {
      const reference = readExact(join(ROOT, pin.path))
      check(reference.length === pin.bytes && sha(reference) === pin.sha256, 'post_retention_reference_integrity')
    }
    verifyDirectory(); unchanged(); before('post_retention_final_checks')
    // Freeze the real availability clock after all retention/source checks and select the original at that same clock.
    const completedAtMs = nativeNow()
    const completedWallElapsedMs = completedAtMs - started, completedMonotonicElapsedMs = performance.now() - mono
    check(Number.isFinite(completedWallElapsedMs) && completedWallElapsedMs >= 0 && completedWallElapsedMs <= QUALIFICATION_MS &&
      Number.isFinite(completedMonotonicElapsedMs) && completedMonotonicElapsedMs >= 0 && completedMonotonicElapsedMs <= QUALIFICATION_MS,
    'availability_deadline')
    check(freeBytes() >= RESERVE, 'availability_reserve')
    check(selectedMorphoV2JointHolderForecastFromIssue(issue, question, completedAtMs) === model, 'available_original_selection')
    const completedAtUtc = new NativeDate(completedAtMs).toISOString()
    console.log(JSON.stringify({ schema: inspection.schema, complete: true, accepted: true, directory, qualifiedAtUtc, completedAtUtc,
      availabilityBoundary: 'after_terminal_all_file_readbacks_reference_source_final_checks_original_selected_at_completed_clock', statusCode, requestCalls, accountedBytes: accounted,
      SDKphysicalStarts: null, HTTP: false, browser: false, executionQualified: false, calibrated: false, coveragePromotion: false }))
  } catch (error) {
    const reason = sanitized(error)
    let failureRetained = false, failedTerminalRetained = false, retentionFailure: string | null = null
    // No raw error message, stack or provider URL enters failure metadata. Never clean up or retry this live request.
    if (directory && directoryIdentity) {
      try {
        json('failure.json', { schema: inspection.schema, complete: false, accepted: false, reason, phase, failedAtUtc: new NativeDate(nativeNow()).toISOString(),
          statusCode, requestCalls, inspection, accountedBytesBeforeFailure: accounted, files: [...files], attempts: [...attempts] }, true, true)
        failureRetained = true
        json('failed-terminal.json', { schema: inspection.schema, complete: false, accepted: false, reason, phase,
          qualificationBoundary: 'failed_no_acceptance_or_post_retention_success_claim', qualifiedAtUtc: null,
          postRetentionAvailableAtUtc: null, terminalRetained, accountedBytesBeforeTerminal: accounted,
          files: [...files], attempts: [...attempts], metadataSelfExcluded: true }, true, true)
        failedTerminalRetained = true
      } catch (retentionError) { retentionFailure = sanitized(retentionError) }
    }
    console.log(JSON.stringify({ schema: inspection.schema, complete: false, accepted: false, directory: directory || null,
      reason, phase, statusCode, requestCalls, failureRetained, failedTerminalRetained, terminalRetained, retentionFailure,
      accountedBytes: accounted, recordedAtUtc: new NativeDate(nativeNow()).toISOString(), SDKphysicalStarts: null,
      HTTP: false, browser: false, executionQualified: false, calibrated: false, coveragePromotion: false }))
    throw Error(reason)
  }
}, 90_000)
