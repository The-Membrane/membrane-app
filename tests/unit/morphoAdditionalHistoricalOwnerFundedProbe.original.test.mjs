import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import {
  PLAN_PATH, PLAN_SHA, ADDITIONAL_HISTORICAL_OWNER_POLICY, ADDITIONAL_HISTORICAL_OWNER_FLAGS,
  prepareMorphoAdditionalHistoricalOwnerFundedProbe, validateAdditionalHistoricalOwnerLead,
  additionalHistoricalOwnerCodeCall, classifyAdditionalHistoricalOwnerCode,
  deriveAdditionalHistoricalOwnerFundedObservation, additionalHistoricalOwnerCredentialVariants,
  assertAdditionalHistoricalOwnerProbePrivacy, assertAdditionalHistoricalOwnerDiskCapacity,
  captureMorphoAdditionalHistoricalOwnerFundedProbe, roundedAdditionalHistoricalOwnerAllocation,
  additionalHistoricalOwnerFixedStorageArtifacts, additionalHistoricalOwnerStorageBudgetProof,
  reconstructAdditionalHistoricalOwnerProbeControl, qualifyAdditionalHistoricalOwnerPostRetentionAvailability,
} from '../../scripts/research/morpho-additional-historical-owner-funded-probe.mjs'
import { createUsd3HypotheticalCaptureControl } from '../../scripts/research/usd3-hypothetical-history-capture.mjs'
import { probeNativeCall, verifyProbeControl } from '../../scripts/research/morpho-observed-funded-holder-probe.mjs'
import { MORPHO_PROBE_ROW_STORAGE_SCHEMA, serializeMorphoProbeStorageValue,
  encodeMorphoProbeNativeRow, decodeMorphoProbeNativeRow, encodedMorphoProbeRowOverheadBytes,
  morphoProbeEncodedRawResponseBytes,
} from '../../scripts/research/morpho-probe-raw-body-storage.mjs'

const sha = (v) => createHash('sha256').update(v).digest('hex')
const clone = (v) => JSON.parse(JSON.stringify(v))
const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8')), hosts = plan.origins
const historicalFixturePlan = JSON.parse(readFileSync('scripts/research/morpho-historical-owner-funded-probe.plan.json', 'utf8'))
const codeSource = readFileSync('scripts/research/morpho-additional-historical-owner-funded-probe.mjs', 'utf8')
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0')
const addressWord = (a) => '0x' + '0'.repeat(24) + a.slice(2)
const source = {
  chainId: 1, blockNumber: '10240', blockHash: word(10240),
  blockTime: '2026-10-09T08:00:00.000Z', finalized: true,
}
const subject = plan.subjects[0], candidate = subject.candidates[0]
function observationRows(S, Ea = 900n, code = '0x', s = subject, c = candidate) {
  const rows = []
  const add = (key, request, result) => rows.push(...hosts.map((host) => ({
    host, key, request, envelope: { result },
  })))
  const ck = s.id + ':ownerCode:' + c.owner, sk = s.id + ':S:' + c.owner, ek = s.id + ':Ea:' + c.owner
  add(ck, additionalHistoricalOwnerCodeCall(ck, c.owner, source), code)
  add(sk, probeNativeCall(sk, s.vault, 'balanceOf', [c.owner], source), word(S))
  if (BigInt(S) > 0n) add(ek, probeNativeCall(ek, s.vault, 'previewRedeem', [BigInt(S)], source), word(Ea))
  return rows
}
function repin(bundle, pin) {
  if (bundle.kind === 'bundle') {
    const { sha256, ...body } = bundle
    bundle.sha256 = sha(JSON.stringify(body))
  }
  const bytes = Buffer.from(JSON.stringify(bundle) + '\n')
  return { bytes, pin: { ...pin, bytes: bytes.length, fileSha256: sha(bytes) } }
}
function leadFixture(s = plan.subjects[2], c = s.candidates[0]) {
  const pin = [...plan.leadOriginals, ...historicalFixturePlan.leadOriginals].find((p) => p.path === c.lead.originalPath)
  const bytes = readFileSync(pin.path)
  return { s: clone(s), c: clone(c), pin, bytes, bundle: JSON.parse(bytes.toString()) }
}

test('the new fixed plan pins its bytes and preserves the old producer and originals', () => {
  assert.equal(sha(readFileSync(PLAN_PATH)), PLAN_SHA)
  for (const pin of [...plan.sourcePins, ...plan.leadOriginals]) {
    const bytes = readFileSync(pin.path)
    assert.equal(bytes.length, pin.bytes, pin.path)
    assert.equal(sha(bytes), pin.fileSha256, pin.path)
  }
  assert.equal(plan.budget.maximumPhysicalStarts, 100)
  assert.equal(plan.budget.maximumPlannedPhysicalStarts, 78)
  assert.equal(plan.budget.maximumLogStarts, 0)
  assert.equal(plan.budget.workers, 1)
  assert.deepEqual(plan.subjects.map((s) => s.candidates.length), [1, 2, 1, 1])
  assert.equal(new Set(plan.subjects.map((s) => s.vault)).size, 4)
  assert.equal(plan.diskBoundary,
    'coupled_269MiB_preflight_256MiB_reserve_10MiB_lossless_cohort_3MiB_allocation_slack')
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.retries, 0)
  assert.equal(plan.subjects.flatMap((s) => s.candidates).length, 5)
})
test('all five exact pinned historical leads validate without establishing remaining historical S', () => {
  const prepared = prepareMorphoAdditionalHistoricalOwnerFundedProbe()
  assert.equal(prepared.leads.length, 5)
  assert.ok(prepared.leads.every((l) => l.proof.historicalHintOnly &&
    l.proof.historicalOwnership === false && l.proof.historicalRemainingSharesKnown === false &&
    l.proof.currentBalanceKnown === false))
  assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.plan) && Object.isFrozen(prepared.sources))
})
test('Deposit selects its exact onBehalf owner at topic 2', () => {
  const f = leadFixture(subject, candidate)
  const proof = validateAdditionalHistoricalOwnerLead(f.bytes, f.pin, f.s, f.c, plan.eventRules)
  assert.equal(proof.ownerField, 'onBehalf')
  assert.equal('0x' + proof.occurrence.topics[2].slice(-40), candidate.owner)
  const foreign = clone(f.c)
  foreign.owner = '0x' + '12'.repeat(20)
  assert.throws(() => validateAdditionalHistoricalOwnerLead(f.bytes, f.pin, f.s, foreign, plan.eventRules), /lead_event_ABI/)
})
test('Withdraw owner is onBehalf at topic 3 even when payout receiver differs', () => {
  const f = leadFixture()
  const receiver = '0x' + '34'.repeat(20)
  for (const slice of f.bundle.slices) for (const witness of slice.witnesses)
    for (const row of witness.raw)
      if (row.transactionHash === f.c.lead.eventRow.transactionHash && row.logIndex === f.c.lead.eventRow.logIndex)
        row.topics[2] = addressWord(receiver)
  f.c.lead.eventRow.topics[2] = addressWord(receiver)
  const p = repin(f.bundle, f.pin)
  assert.equal(validateAdditionalHistoricalOwnerLead(p.bytes, p.pin, f.s, f.c, plan.eventRules).ownerField, 'onBehalf')
  f.c.owner = receiver
  assert.throws(() => validateAdditionalHistoricalOwnerLead(p.bytes, p.pin, f.s, f.c, plan.eventRules), /lead_event_ABI/)
})
test('Withdraw cannot silently use sender or payout receiver indices', () => {
  const f = leadFixture()
  f.c.lead.ownerTopicIndex = 2
  assert.throws(() => validateAdditionalHistoricalOwnerLead(f.bytes, f.pin, f.s, f.c, plan.eventRules), /lead_rule/)
})
test('single origin April decoded mint inputs remain hints with no paired event header assertion', () => {
  for (const c of historicalFixturePlan.subjects[2].candidates.slice(1)) {
    const f = leadFixture(historicalFixturePlan.subjects[2], c)
    const p = validateAdditionalHistoricalOwnerLead(f.bytes, f.pin, f.s, f.c, plan.eventRules)
    assert.equal(p.historicalSelectorDeclaredOnly, true)
    assert.equal(p.historicalPairedEventHeaders, false)
    assert.equal(p.occurrence.header, null)
    assert.equal(p.historicalOwnership, false)
  }
})
test('decoded mint hints reject a nonzero sender or changed receiver', () => {
  for (const change of [(r) => { r.from = '0x' + '11'.repeat(20) },
    (r) => { r.to = '0x' + '22'.repeat(20) }]) {
    const f = leadFixture(historicalFixturePlan.subjects[2], historicalFixturePlan.subjects[2].candidates[1])
    const index = f.bundle.logs.findIndex((r) => JSON.stringify(r) === JSON.stringify(f.c.lead.eventRow))
    change(f.bundle.logs[index]); change(f.c.lead.eventRow)
    const p = repin(f.bundle, f.pin)
    assert.throws(() => validateAdditionalHistoricalOwnerLead(p.bytes, p.pin, f.s, f.c, plan.eventRules), /decoded_mint_receiver/)
  }
})
test('decoded single origin hints reject manufactured paired header authority', () => {
  const f = leadFixture(historicalFixturePlan.subjects[2], historicalFixturePlan.subjects[2].candidates[2])
  f.c.lead.pairedEventHeaders = true
  assert.throws(() => validateAdditionalHistoricalOwnerLead(f.bytes, f.pin, f.s, f.c, plan.eventRules), /decoded_transfer_hint/)
})
test('lead file mutation and foreign canonical event headers are rejected', () => {
  const f = leadFixture()
  assert.throws(() => validateAdditionalHistoricalOwnerLead(Buffer.concat([f.bytes, Buffer.from(' ')]), f.pin,
    f.s, f.c, plan.eventRules), /lead_file_pin/)
  f.c.lead.eventHeader.hash = word(7)
  assert.throws(() => validateAdditionalHistoricalOwnerLead(f.bytes, f.pin, f.s, f.c, plan.eventRules), /lead_event_header/)
})
test('both raw historical origin witnesses must agree', () => {
  const f = leadFixture()
  const slice = f.bundle.slices.find((s) => s.witnesses[0].raw.some((row) =>
    JSON.stringify(row) === JSON.stringify(f.c.lead.eventRow)))
  assert.ok(slice, 'the mutated slice contains the pinned event')
  slice.witnesses[1].raw = []
  const p = repin(f.bundle, f.pin)
  assert.throws(() => validateAdditionalHistoricalOwnerLead(p.bytes, p.pin, f.s, f.c, plan.eventRules), /lead_pair/)
})
test('current owner code reads use the exact hash and requireCanonical', () => {
  assert.deepEqual(additionalHistoricalOwnerCodeCall('owner', candidate.owner, source), {
    key: 'owner', method: 'eth_getCode',
    params: [candidate.owner, { blockHash: source.blockHash, requireCanonical: true }],
  })
  assert.throws(() => additionalHistoricalOwnerCodeCall('owner', candidate.owner, { blockHash: 'latest' }))
})
test('EOA and exact EIP7702 code patterns never establish wallet key control', () => {
  assert.equal(classifyAdditionalHistoricalOwnerCode('0x').ownerCodeStatus, 'no_code')
  const delegation = '0xef0100' + 'ab'.repeat(20)
  const result = classifyAdditionalHistoricalOwnerCode(delegation)
  assert.equal(result.ownerCodeStatus, 'eip7702_delegated')
  assert.equal(result.rawCode, delegation)
  assert.equal(result.transactionOriginCodeCompatible, true)
  assert.equal(result.currentWalletControl, false)
  assert.equal(result.forecastEligibility, false)
})
test('truncated or extended EIP7702 markers remain contract code', () => {
  for (const code of ['0x6000', '0xef0100' + 'ab'.repeat(19), '0xef0100' + 'ab'.repeat(21)]) {
    assert.equal(classifyAdditionalHistoricalOwnerCode(code).ownerCodeStatus, 'contract_code')
    assert.equal(classifyAdditionalHistoricalOwnerCode(code).transactionOriginCodeCompatible, false)
  }
  for (const code of ['', '0x0', 'bad', null]) assert.throws(() => classifyAdditionalHistoricalOwnerCode(code))
})
test('full observed S is independently previewed with no Q scaling', () => {
  const S = 987654321098765432109n, Ea = 123456789n
  const result = deriveAdditionalHistoricalOwnerFundedObservation(observationRows(S, Ea), subject, candidate, source)
  assert.equal(result.sharesRaw, String(S))
  assert.equal(result.fullEaRaw, String(Ea))
  assert.equal(result.status, 'paired_native_funded_balance')
  assert.equal(result.forecastEligibility, false)
  for (const [key, value] of Object.entries(ADDITIONAL_HISTORICAL_OWNER_FLAGS)) assert.equal(result[key], value)
})
test('positive contract balances stay research observations with forecast eligibility false', () => {
  const result = deriveAdditionalHistoricalOwnerFundedObservation(observationRows(5n, 7n, '0x6000'), subject, candidate, source)
  assert.equal(result.sharesRaw, '5')
  assert.equal(result.fullEaRaw, '7')
  assert.equal(result.ownerCodeStatus, 'contract_code')
  assert.equal(result.forecastEligibility, false)
  assert.equal(result.currentWalletControl, false)
})
test('EOA compatible code with zero S triggers no preview and is not a funded owner', () => {
  const rows = observationRows(0n)
  const result = deriveAdditionalHistoricalOwnerFundedObservation(rows, subject, candidate, source)
  assert.equal(result.status, 'zero_native_balance')
  assert.equal(result.fullEaRaw, null)
  rows.push(...observationRows(1n).filter((r) => r.key.includes(':Ea:')))
  assert.throws(() => deriveAdditionalHistoricalOwnerFundedObservation(rows, subject, candidate, source), /zero_S_no_preview/)
})
test('positive S with zero Ea remains an observed funded share balance', () => {
  const result = deriveAdditionalHistoricalOwnerFundedObservation(observationRows(2n, 0n), subject, candidate, source)
  assert.equal(result.status, 'paired_native_funded_balance_zero_entitlement')
  assert.equal(result.fullEaRaw, '0')
})
test('one origin, changed code, changed S or changed Ea cannot qualify', () => {
  for (const keyPart of [':ownerCode:', ':S:', ':Ea:']) {
    const rows = observationRows(1n), row = rows.find((r) => r.host === hosts[1] && r.key.includes(keyPart))
    row.envelope.result = keyPart === ':ownerCode:' ? '0x6000' : word(17)
    assert.throws(() => deriveAdditionalHistoricalOwnerFundedObservation(rows, subject, candidate, source), /paired_result/)
  }
  assert.throws(() => deriveAdditionalHistoricalOwnerFundedObservation(observationRows(1n).slice(1), subject, candidate, source))
})
test('foreign owner, number fallback and Q instead of full S all reject', () => {
  for (const change of [
    (rows) => { rows[0].request.params[0] = '0x' + 'cd'.repeat(20) },
    (rows) => { rows[2].request.params[1] = '0x2800' },
    (rows) => { rows[4].request = probeNativeCall(rows[4].key, subject.vault, 'previewRedeem', [1n], source) },
  ]) {
    const rows = clone(observationRows(100n)); change(rows)
    assert.throws(() => deriveAdditionalHistoricalOwnerFundedObservation(rows, subject, candidate, source), /native_request_source/)
  }
})

const privacyOrigins = hosts.map((host) => ({ host, url: 'https://' + host + '/rpc/fixture-secret-42' }))
const privacySecrets = additionalHistoricalOwnerCredentialVariants(privacyOrigins)
// The synthetic native endpoint key must not occur in the immutable old test source pinned by preparation.
const origins = hosts.map((host) => ({ host,
  url: 'https://' + host + '/rpc/' + ['isolated', 'owner', 'probe', 'mock', 'rpc', 'key'].join('-') }))
test('credential privacy catches actual endpoint keys in source, descriptors and Base64 raw responses', () => {
  for (const value of [
    { sourceText: 'const key = "fixture-secret-42"' },
    { 'fixture-secret-42': true },
    { rawBodyBase64: Buffer.from('{"fixture-secret-42":true}').toString('base64') },
    { base64: Buffer.from('fixture-secret-42').toString('base64') },
  ]) assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy(value, privacySecrets), /credential_echo/)
})
test('privacy recursively decodes mixed Unicode escaped JSON keys and values', () => {
  const escaped = 'fixture-\\u0073ecret-42'
  for (const raw of ['{"' + escaped + '":true}', '{"x":"' + escaped + '"}']) {
    assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy({ sourceText: raw }, privacySecrets), /credential_echo/)
    assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy({ rawBodyBase64: Buffer.from(raw).toString('base64') }, privacySecrets), /credential_echo/)
  }
})
test('source text mixed Unicode and hex escapes cannot conceal an actual endpoint key', () => {
  for (const sourceText of [
    'const x = "fixture-\\u0073ecret-42"',
    'const x = "fixture-\\x73ecret-42"',
    'const x = "fixture-\\u{73}ecret-42"',
    'const x = "fixture-\\\\u0073ecret-42"',
  ]) assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy({ sourceText }, privacySecrets), /credential_echo/)
})
test('privacy rejects accessors without invoking them, cycles and malformed escaped raw bodies', () => {
  let invoked = 0
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { invoked++; return 'secret' } })
  assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy(getter, privacySecrets), /privacy_descriptor/)
  assert.equal(invoked, 0)
  const cycle = {}; cycle.x = cycle
  assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy(cycle, privacySecrets))
  assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy({ rawBodyBase64: Buffer.from('{"x":"\\u').toString('base64') }, privacySecrets))
})

function nativeFixture({ mismatchOwner = false, mismatchAfter = false, errorBalance = false,
  redirected = false, oversize = false, timeout = false, allPositive = false, paddedResponseBytes = 0 } = {}) {
  let time = 0, fetches = 0, inFlight = 0, maximumInFlight = 0, afterCount = 0
  const base = Date.parse('2026-10-09T08:20:00.000Z')
  const fetcher = async (url, options) => {
    fetches++; inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight); time++
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    const request = JSON.parse(options.body)
    assert.notEqual(request.method, 'eth_getLogs')
    let result
    if (timeout) return new Promise(() => {})
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      if (request.params[0] !== 'finalized') afterCount++
      result = { number: '0x2800', hash: mismatchAfter && afterCount > 2 ? word(11) : source.blockHash,
        timestamp: '0x' + (Date.parse(source.blockTime) / 1000).toString(16) }
    } else {
      assert.deepEqual(request.params[1], { blockHash: source.blockHash, requireCanonical: true })
      if (request.method === 'eth_getCode') {
        const isOwner = plan.subjects.some((s) => s.candidates.some((c) => c.owner === request.params[0]))
        result = isOwner ? request.params[0] === candidate.owner ? '0x' : '0x6000' : '0x6001'
        if (isOwner && mismatchOwner && new URL(url).hostname === hosts[1]) result = '0x6002'
      } else {
        assert.equal(request.method, 'eth_call')
        const { to, data } = request.params[0]
        const s = plan.subjects.find((s) => s.vault === to || s.asset === to)
        if (data === '0x38d52e0f') result = addressWord(s.asset)
        else if (data === '0x313ce567') result = word(to === s.vault ? 18 : s.assetDecimals)
        else if (data.startsWith('0x70a08231')) {
          result = word(!allPositive && data.endsWith(candidate.owner.slice(2)) ? 0n : 1234567890123456789n)
          if (errorBalance) {
            inFlight--
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
              error: { code: 3, message: 'bounded_fixture_error' } }), { status: 200 })
          }
        } else {
          assert.ok(data.startsWith('0x4cdad506'))
          assert.equal(BigInt('0x' + data.slice(10)), 1234567890123456789n)
          result = word(987654321n)
        }
      }
    }
    const bytes = JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    const padding = paddedResponseBytes ? ' '.repeat(paddedResponseBytes - Buffer.byteLength(bytes)) : ''
    const response = new Response(oversize ? bytes + ' '.repeat(65536) : bytes + padding, { status: 200 })
    if (redirected) Object.defineProperty(response, 'redirected', { value: true })
    inFlight--
    return response
  }
  const options = { fetcher, now: () => base + time, monotonic: () => time,
    pace: async (n) => { time += n } }
  if (timeout) {
    options.setTimer = (callback, delay) => {
      if (delay <= 8000) { time += delay; queueMicrotask(callback) }
      return 0
    }
    options.clearTimer = () => {}
  }
  return { options, fetches: () => fetches, maximumInFlight: () => maximumInFlight }
}
test('controlled current capture closes at 76 starts with one worker and no log requests', async () => {
  const mock = nativeFixture(), prepared = prepareMorphoAdditionalHistoricalOwnerFundedProbe()
  const result = await captureMorphoAdditionalHistoricalOwnerFundedProbe(prepared, origins, mock.options)
  assert.equal(result.complete, true, result.failure)
  assert.equal(result.physicalStarts, 76)
  assert.equal(result.physicalStarts, mock.fetches())
  assert.equal(mock.maximumInFlight(), 1)
  assert.equal(result.outputs.length, 5)
  assert.equal(result.outputs.filter((r) => r.sharesRaw === '0').length, 1)
  assert.ok(result.outputs.every((r) => r.forecastEligibility === false && r.currentWalletControl === false))
  assert.ok(result.receipt.ledger.every((r) => r.request.method !== 'eth_getLogs'))
  assert.equal(result.requests.length, result.settlements.length)
  assert.equal(verifyProbeControl(result.receipt, result.requests, result.settlements, result.namespace), true)
})
test('foreign origins and unprepared plan objects cannot start any read', async () => {
  const mock = nativeFixture(), prepared = prepareMorphoAdditionalHistoricalOwnerFundedProbe()
  await assert.rejects(captureMorphoAdditionalHistoricalOwnerFundedProbe({ ...prepared }, origins, mock.options), /prepared_original/)
  await assert.rejects(captureMorphoAdditionalHistoricalOwnerFundedProbe(prepared,
    [{ host: hosts[0], url: 'https://evil.example/rpc' }, origins[1]], mock.options), /origins/)
  assert.equal(mock.fetches(), 0)
})
test('direct capture below the real preflight floor starts zero native reads', async () => {
  const begin = codeSource.indexOf('export async function captureMorphoAdditionalHistoricalOwnerFundedProbe(')
  const end = codeSource.indexOf('/** This separate prefix', begin)
  const exact = codeSource.slice(begin, end).replace('export async function', 'async function')
  const guardBegin = codeSource.indexOf('function guard(')
  const guardEnd = codeSource.indexOf('function fixedPath(', guardBegin)
  const checkBegin = codeSource.indexOf('const check = ')
  const checkEnd = codeSource.indexOf('const seal = ', checkBegin)
  let reads = 0, controls = 0, diskChecks = 0
  const context = {
    ROOT: '/repo', POLICY: ADDITIONAL_HISTORICAL_OWNER_POLICY, assertAdditionalHistoricalOwnerDiskCapacity,
    statfsSync: () => { diskChecks++; return { bavail: BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.pre - 1), bsize: 1n } },
    createUsd3HypotheticalCaptureControl: () => { controls++; throw Error('unexpected_control') },
  }
  const capture = vm.runInNewContext(codeSource.slice(checkBegin, checkEnd) +
    codeSource.slice(guardBegin, guardEnd) + exact +
    ';captureMorphoAdditionalHistoricalOwnerFundedProbe', context)
  await assert.rejects(capture({}, origins, { fetcher: async () => { reads++ } }), /disk_preflight/)
  assert.equal(diskChecks, 1)
  assert.equal(controls, 0)
  assert.equal(reads, 0)
})
test('changed owner code pairing or changed after bracket leaves the capture incomplete', async () => {
  for (const flag of ['mismatchOwner', 'mismatchAfter']) {
    const mock = nativeFixture({ [flag]: true })
    const result = await captureMorphoAdditionalHistoricalOwnerFundedProbe(prepareMorphoAdditionalHistoricalOwnerFundedProbe(), origins, mock.options)
    assert.equal(result.complete, false)
    assert.ok(result.physicalStarts <= 78)
  }
})
test('a native error retains its raw predispatch request, response, settlement and terminal join', async () => {
  const mock = nativeFixture({ errorBalance: true })
  const result = await captureMorphoAdditionalHistoricalOwnerFundedProbe(prepareMorphoAdditionalHistoricalOwnerFundedProbe(), origins, mock.options)
  assert.equal(result.complete, false)
  const row = result.receipt.ledger.at(-1), req = result.requests.at(-1), settlement = result.settlements.at(-1)
  assert.equal(req.physicalId, row.physicalId)
  assert.equal(settlement.physicalId, row.physicalId)
  assert.equal(sha(Buffer.from(req.requestBodyBase64, 'base64')), req.requestBodySha256)
  assert.ok(JSON.parse(Buffer.from(row.rawBodyBase64, 'base64').toString()).error)
  assert.equal(result.receipt.terminalCommitments.at(-1).rowSha256, sha(JSON.stringify(row)))
})
test('redirected responses and oversized bodies stop without retry', async () => {
  for (const flag of ['redirected', 'oversize']) {
    const mock = nativeFixture({ [flag]: true })
    const result = await captureMorphoAdditionalHistoricalOwnerFundedProbe(prepareMorphoAdditionalHistoricalOwnerFundedProbe(), origins, mock.options)
    assert.equal(result.complete, false)
    assert.equal(mock.fetches(), 1)
  }
})
test('an eight second timeout stops starts and retains the pending terminal row without retry', async () => {
  const mock = nativeFixture({ timeout: true })
  const result = await captureMorphoAdditionalHistoricalOwnerFundedProbe(prepareMorphoAdditionalHistoricalOwnerFundedProbe(), origins, mock.options)
  assert.equal(result.complete, false)
  assert.equal(mock.fetches(), 1)
  assert.equal(result.receipt.ledger.length, 1)
  assert.ok(result.receipt.pendingSettlements > 0)
})
test('raw native commitments cannot be accepted after body or settlement mutation', async () => {
  const mock = nativeFixture()
  const result = await captureMorphoAdditionalHistoricalOwnerFundedProbe(prepareMorphoAdditionalHistoricalOwnerFundedProbe(), origins, mock.options)
  const changed = clone(result.receipt)
  changed.ledger[0].bodySha256 = '0'.repeat(64)
  assert.throws(() => verifyProbeControl(changed, result.requests, result.settlements, result.namespace), /raw_row_join/)
  const settlements = clone(result.settlements)
  settlements[0].sha256 = '0'.repeat(64)
  assert.throws(() => verifyProbeControl(result.receipt, result.requests, settlements, result.namespace), /settlement_join/)
})
test('maximum 64 KiB whitespace-padded responses reach all 78 starts and reconstructs exact native commitments', async () => {
  const mock = nativeFixture({ allPositive: true, paddedResponseBytes: 65536 })
  const result = await captureMorphoAdditionalHistoricalOwnerFundedProbe(prepareMorphoAdditionalHistoricalOwnerFundedProbe(), origins, mock.options)
  assert.equal(result.complete, true, result.failure)
  assert.equal(result.physicalStarts, 78)
  const originalReceipt = JSON.stringify(result.receipt), originalSettlements = JSON.stringify(result.settlements)
  const restored = reconstructAdditionalHistoricalOwnerProbeControl(result.receipt, result.requests, result.settlements,
    result.namespace, result.source)
  assert.equal(restored.aggregateRawResponseBytes, 78 * 65536)
  assert.ok(restored.aggregateRawResponseBytes > 0.97 * ADDITIONAL_HISTORICAL_OWNER_POLICY.rawAggregate)
  assert.equal(JSON.stringify(restored.receipt), originalReceipt)
  assert.equal(JSON.stringify(restored.settlements), originalSettlements)
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(result.requests))
  assert.equal(sha(JSON.stringify(restored.receipt)), sha(originalReceipt))
  assert.equal(verifyProbeControl(restored.receipt, restored.requests, restored.settlements, result.namespace), true)
  assert.ok(result.outputs.every((r) => BigInt(r.sharesRaw) > 0n && r.fullEaRaw === '987654321' &&
    r.forecastEligibility === false && r.currentWalletControl === false))
  assert.equal(result.outputs[0].ownerCodeStatus, 'no_code')
  assert.ok(result.outputs.some((r) => r.ownerCodeStatus === 'contract_code'))
  assert.equal(JSON.stringify(result.receipt), originalReceipt)
  assert.equal(JSON.stringify(result.settlements), originalSettlements)
})
test('storage proof measures the actual fixed serializer and includes the full padded Base64 and allocation maxima', () => {
  const prepared = prepareMorphoAdditionalHistoricalOwnerFundedProbe()
  const artifacts = additionalHistoricalOwnerFixedStorageArtifacts(prepared), proof = additionalHistoricalOwnerStorageBudgetProof(prepared)
  const actual = artifacts.reduce((n, artifact) => n + serializeMorphoProbeStorageValue(artifact.value).length, 0)
  assert.equal(proof.fixedSerializedBytes, actual)
  assert.equal(proof.fixedFiles, artifacts.length)
  assert.equal(proof.maximumLogicalBytes, actual + proof.maximumBase64Bytes +
    ADDITIONAL_HISTORICAL_OWNER_POLICY.starts * ADDITIONAL_HISTORICAL_OWNER_POLICY.rowOverhead +
    ADDITIONAL_HISTORICAL_OWNER_POLICY.controlSummary + ADDITIONAL_HISTORICAL_OWNER_POLICY.report + ADDITIONAL_HISTORICAL_OWNER_POLICY.terminal)
  assert.ok(proof.maximumLogicalBytes <= 10 * 1024 * 1024)
  assert.ok(proof.maximumFiles < 132)
  assert.ok(proof.maximumAllocationExtra <= 3 * 1024 * 1024)
  const oversized = { ...prepared, sources: [...prepared.sources, { pin: { path: 'oversized' },
    bytes: Buffer.alloc(2 * 1024 * 1024, 'x') }] }
  assert.throws(() => additionalHistoricalOwnerStorageBudgetProof(oversized), /fixed_serialization_bound/)
})
test('the unchanged controller retains a 5 MiB crossing row losslessly as a failed overshoot', async () => {
  const mock = nativeFixture({ paddedResponseBytes: 65536 })
  const control = createUsd3HypotheticalCaptureControl(origins, mock.options)
  const namespace = 'historical-owner-native-additional-aggregate-control', requests = []
  control.beginStage('aggregate_crossing')
  let failure = null
  for (let id = 1; id <= 81; id++) {
    const origin = origins[(id - 1) % origins.length]
    const request = { jsonrpc: '2.0', id, method: 'eth_chainId', params: [] }, body = JSON.stringify(request)
    const record = { controlNamespace: namespace, physicalId: null, rpcId: id, key: 'crossing:' + id,
      host: origin.host, requestBodyBase64: Buffer.from(body).toString('base64'), requestBodySha256: sha(body) }
    requests.push(record)
    try {
      const response = await control.fetcher(origin.url, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body })
      record.physicalId = Number(response.headers.get('x-usd3-physical-id'))
      await response.text()
    } catch (error) { failure = error; break }
  }
  const receipt = await control.finish(), settlements = structuredClone(control.settlementReceipts)
  for (const request of requests) if (request.physicalId === null) {
    const row = receipt.ledger.find((r) => r.host === request.host && r.request.id === request.rpcId)
    if (row) request.physicalId = row.physicalId
  }
  assert.ok(failure)
  assert.equal(receipt.physicalStarts, 81)
  assert.equal(receipt.ledger.at(-1).accepted, false)
  assert.equal(receipt.ledger.at(-1).status, 'failed')
  const restored = reconstructAdditionalHistoricalOwnerProbeControl(receipt, requests, settlements, namespace, null)
  assert.equal(restored.aggregateRawResponseBytes, 81 * 65536)
  assert.equal(restored.aggregateRawResponseBytes, ADDITIONAL_HISTORICAL_OWNER_POLICY.retainedRawAggregate)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(receipt))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(settlements))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(requests))
})
test('failed and pending rows reconstruct without dropping their requests or changing their original terminal state', async () => {
  for (const flag of ['errorBalance', 'timeout', 'oversize']) {
    const mock = nativeFixture({ [flag]: true })
    const result = await captureMorphoAdditionalHistoricalOwnerFundedProbe(prepareMorphoAdditionalHistoricalOwnerFundedProbe(), origins, mock.options)
    const restored = reconstructAdditionalHistoricalOwnerProbeControl(result.receipt, result.requests, result.settlements,
      result.namespace, result.source)
    assert.equal(JSON.stringify(restored.receipt), JSON.stringify(result.receipt))
    assert.equal(JSON.stringify(restored.requests), JSON.stringify(result.requests))
    assert.equal(JSON.stringify(restored.settlements), JSON.stringify(result.settlements))
  }
})

function writerFixture() {
  const begin = codeSource.indexOf('export function createAdditionalHistoricalOwnerProbeWriter(')
  const end = codeSource.indexOf('export async function runMorphoAdditionalHistoricalOwnerFundedProbe(', begin)
  const exact = codeSource.slice(begin, end).replace('export function', 'function')
  const files = new Map(), fds = new Map()
  const state = { next: 1, time: 0, failFsync: false, corruptReadback: false,
    nlink: 1, directoryInode: 0, syncs: 0, guards: [], free: BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.pre) }
  const out = '/repo/data/research/venue-signals/morpho-additional-historical-owner-funded-probe-fixture'
  const stat = (file, path = '') => ({
    isFile: () => Boolean(file), isDirectory: () => !file, isSymbolicLink: () => false,
    dev: 1, ino: file?.ino ?? (path === out ? state.directoryInode : 0),
    size: file?.bytes.length ?? 0, nlink: state.nlink, mode: file ? 0o600 : 0o700,
  })
  const context = {
    Buffer, performance: { now: () => state.time }, POLICY: ADDITIONAL_HISTORICAL_OWNER_POLICY,
    serializeMorphoProbeStorageValue, roundedAdditionalHistoricalOwnerAllocation, MORPHO_PROBE_ROW_STORAGE_SCHEMA,
    encodedMorphoProbeRowOverheadBytes, morphoProbeEncodedRawResponseBytes,
    dirname: (p) => p.slice(0, p.lastIndexOf('/')), basename: (p) => p.slice(p.lastIndexOf('/') + 1),
    resolve: (a, b) => b ? a + '/' + b : a, fixedPath: () => '/repo/data/research/venue-signals',
    constants: { O_RDONLY: 1, O_DIRECTORY: 2, O_NOFOLLOW: 4, O_WRONLY: 8, O_CREAT: 16, O_EXCL: 32 },
    guard: (bytes = 0, terminal = false, preflight = false) => {
      state.guards.push({ bytes, terminal, preflight })
      assertAdditionalHistoricalOwnerDiskCapacity(state.free, bytes, terminal, preflight)
    },
    check: (ok, reason) => assert.ok(ok, reason), sha,
    assertAdditionalHistoricalOwnerProbePrivacy, mkdirSync: (_p, opts) => assert.equal(opts.mode, 0o700),
    lstatSync: (p) => stat(files.get(p), p),
    openSync: (p, flags, mode) => {
      assert.ok(flags & 4)
      const fd = state.next++
      if (flags & 16) {
        assert.ok(flags & 32); assert.equal(mode, 0o600); assert.ok(!files.has(p), 'exclusive')
        files.set(p, { bytes: Buffer.alloc(0), ino: fd })
      }
      fds.set(fd, p); return fd
    },
    closeSync: (fd) => fds.delete(fd), fstatSync: (fd) => stat(files.get(fds.get(fd))),
    writeSync: (fd, bytes, offset, length) => {
      const file = files.get(fds.get(fd)); file.bytes = Buffer.concat([file.bytes, bytes.subarray(offset, offset + length)])
      state.free -= BigInt(roundedAdditionalHistoricalOwnerAllocation(length) + ADDITIONAL_HISTORICAL_OWNER_POLICY.fileAllocationMargin)
      return length
    },
    fsyncSync: (fd) => { state.syncs++; if (state.failFsync && files.has(fds.get(fd))) throw Error('fsync_failed') },
    readBytes: (p) => state.corruptReadback ? Buffer.from('corrupt') : files.get(p).bytes,
  }
  const create = vm.runInNewContext(exact + ';createAdditionalHistoricalOwnerProbeWriter', context)
  return { create, writer: create(out, privacySecrets, { clock: () => state.time, started: 0 }), out, state, files }
}
test('the dedicated writer reserves the terminal and uses private nofollow exclusive files with fsync/readback', () => {
  const f = writerFixture(), ref = f.writer.write('fixture.json', { safe: true })
  assert.equal(ref.fileSha256, sha(f.files.get(f.out + '/fixture.json').bytes))
  assert.ok(f.state.syncs >= 3)
  assert.doesNotThrow(() => f.writer.verifyRetained())
  assert.throws(() => f.writer.write('fixture.json', {}), /exclusive/)
  assert.throws(() => f.create(f.out.replace('historical-owner-funded', 'observed-funded-holder'), []), /output_root/)
})
test('retention may cross below 269 MiB while maintaining the 256 MiB reserve and terminal allocation', () => {
  const f = writerFixture()
  assert.equal(f.state.free, BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.pre))
  f.writer.write('first.json', { body: 'x'.repeat(1024 * 1024) })
  assert.ok(f.state.free < BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.pre))
  assert.doesNotThrow(() => f.writer.write('second.json', { body: 'x'.repeat(1024 * 1024) }))
  assert.ok(f.state.free > BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve + ADDITIONAL_HISTORICAL_OWNER_POLICY.terminal))
  assert.ok(f.state.guards.every((g) => g.preflight === false))
  assert.equal(f.writer.refs.length, 2)
})
test('writer initialization after capture applies reserve without a second preflight', () => {
  const f = writerFixture()
  f.state.free = BigInt(270 * 1024 * 1024)
  assert.doesNotThrow(() => f.create(f.out + '-postcapture', privacySecrets))
  f.state.free = BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve + ADDITIONAL_HISTORICAL_OWNER_POLICY.terminal - 1)
  assert.throws(() => f.create(f.out + '-belowreserve', privacySecrets), /disk_reserve/)
})
test('regular writes refuse reserve plus pending bytes and reserved terminal before creating the file', () => {
  const f = writerFixture(), value = { safe: true }, bytes = Buffer.byteLength(JSON.stringify(value) + '\n')
  const pending = roundedAdditionalHistoricalOwnerAllocation(bytes) + ADDITIONAL_HISTORICAL_OWNER_POLICY.fileAllocationMargin
  const terminal = roundedAdditionalHistoricalOwnerAllocation(ADDITIONAL_HISTORICAL_OWNER_POLICY.terminal) + ADDITIONAL_HISTORICAL_OWNER_POLICY.fileAllocationMargin
  f.state.free = BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve + terminal + pending - 1)
  assert.throws(() => f.writer.write('underreserve.json', value), /disk_reserve/)
  assert.equal(f.files.size, 0)
  f.state.free++
  assert.doesNotThrow(() => f.writer.write('atreserve.json', value))
  assert.equal(f.state.free, BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve + terminal))
})
test('terminal writes spend the reserved terminal allocation but never the 256 MiB reserve', () => {
  const f = writerFixture(), value = { complete: false }, bytes = Buffer.byteLength(JSON.stringify(value) + '\n')
  const pending = roundedAdditionalHistoricalOwnerAllocation(bytes) + ADDITIONAL_HISTORICAL_OWNER_POLICY.fileAllocationMargin
  f.state.free = BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve + pending - 1)
  assert.throws(() => f.writer.write('terminal.json', value, true), /disk_reserve/)
  assert.equal(f.files.size, 0)
  f.state.free++
  assert.doesNotThrow(() => f.writer.write('terminal.json', value, true))
  assert.equal(f.state.free, BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve))
})
test('allocation rounding and per-file margins are charged while preflight refuses below 269 MiB', () => {
  assert.equal(roundedAdditionalHistoricalOwnerAllocation(0), 0)
  assert.equal(roundedAdditionalHistoricalOwnerAllocation(1), ADDITIONAL_HISTORICAL_OWNER_POLICY.allocationUnit)
  assert.equal(roundedAdditionalHistoricalOwnerAllocation(ADDITIONAL_HISTORICAL_OWNER_POLICY.allocationUnit + 1),
    2 * ADDITIONAL_HISTORICAL_OWNER_POLICY.allocationUnit)
  assert.throws(() => assertAdditionalHistoricalOwnerDiskCapacity(BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.pre - 1), 0, false, true), /disk_preflight/)
  assert.doesNotThrow(() => assertAdditionalHistoricalOwnerDiskCapacity(BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.pre), 0, false, true))
  const f = writerFixture()
  f.writer.write('tiny.json', { x: 1 })
  assert.equal(f.writer.allocated(), ADDITIONAL_HISTORICAL_OWNER_POLICY.allocationUnit + ADDITIONAL_HISTORICAL_OWNER_POLICY.fileAllocationMargin)
  assert.equal(f.writer.filesAttempted(), 1)
})
test('file count reserves the final terminal and stays below 132 even for tiny artifacts', () => {
  const f = writerFixture()
  for (let i = 0; i < ADDITIONAL_HISTORICAL_OWNER_POLICY.files - 1; i++) f.writer.write('tiny-' + i + '.json', {})
  assert.throws(() => f.writer.write('overflow.json', {}), /write_cap/)
  assert.doesNotThrow(() => f.writer.write('terminal.json', {}, true))
  assert.equal(f.writer.filesAttempted(), 131)
})
test('failed fsync writes retain their logical and rounded allocation charges', () => {
  const f = writerFixture()
  f.state.failFsync = true
  assert.throws(() => f.writer.write('charged.json', { safe: true }))
  assert.ok(f.writer.used() > 0 && f.writer.allocated() > f.writer.used())
  assert.equal(f.writer.filesAttempted(), 1)
  assert.equal(f.writer.refs.length, 0)
})
test('writer fsync failure, changed inode, multiple links and corrupt readback never yield a reference', () => {
  for (const setup of [
    (f) => { f.state.failFsync = true }, (f) => { f.state.directoryInode = 8 },
    (f) => { f.state.nlink = 2 }, (f) => { f.state.corruptReadback = true },
  ]) {
    const f = writerFixture(); setup(f)
    assert.throws(() => f.writer.write('fixture.json', {}))
    assert.equal(f.writer.refs.length, 0)
  }
})
test('writer rejects files over 8 MiB, terminal over 64 KiB, and writes after 120 seconds', () => {
  const f = writerFixture()
  assert.throws(() => f.writer.write('big.json', { body: 'x'.repeat(8 * 1024 * 1024) }), /write_cap/)
  assert.throws(() => f.writer.write('terminal.json', { body: 'x'.repeat(65536) }, true), /write_cap/)
  f.state.time = 120001
  assert.throws(() => f.writer.write('late.json', {}), /retention_deadline/)
})
test('writer privacy blocks raw source and endpoint credentials before creating a file', () => {
  const f = writerFixture()
  assert.throws(() => f.writer.write('leak.json', { sourceText: 'fixture-secret-42' }), /credential_echo/)
  assert.equal(f.files.size, 0)
})
test('post retention availability follows terminal, original/source recheck, readback identity and deadline checks', () => {
  const terminal = codeSource.indexOf("const terminal = writer.write('terminal.json'")
  const recheck = codeSource.indexOf('verifyPrepared(prepared)', terminal)
  const retained = codeSource.indexOf('writer.verifyRetained(); writer.deadline()', recheck)
  const reserve = codeSource.indexOf('const finalDisk = statfsSync(ROOT', retained)
  const clock = codeSource.indexOf('const availableAtMs = Date.now(), elapsedMs = performance.now() - started', reserve)
  assert.ok(terminal > 0 && recheck > terminal && retained > recheck && clock > retained)
  assert.ok(reserve > retained && clock > reserve)
  assert.ok(codeSource.includes("qualificationBoundary: 'before_terminal_fsync', retentionQualified: false"))
})
test('one final availability clock qualifies the exact source TTL, monotonic deadline and actual 256 MiB reserve', () => {
  const boundary = { availableAtMs: Date.parse(source.blockTime) + 1800000,
    elapsedMs: 120000, freeBytes: BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve), source, complete: true }
  assert.equal(qualifyAdditionalHistoricalOwnerPostRetentionAvailability(boundary), new Date(boundary.availableAtMs).toISOString())
  assert.throws(() => qualifyAdditionalHistoricalOwnerPostRetentionAvailability({ ...boundary,
    availableAtMs: boundary.availableAtMs + 1 }), /post_retention_source_age/)
  assert.throws(() => qualifyAdditionalHistoricalOwnerPostRetentionAvailability({ ...boundary,
    elapsedMs: 120000.001 }), /retention_deadline/)
  assert.throws(() => qualifyAdditionalHistoricalOwnerPostRetentionAvailability({ ...boundary,
    freeBytes: BigInt(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve - 1) }), /post_retention_reserve/)
})
test('global caps, private filesystem policy and control dispatch are statically closed', () => {
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.timeout, 8000)
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.stage, 12000)
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.spacing, 250)
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.response, 65536)
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.pre, 269 * 1024 * 1024)
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.reserve, 256 * 1024 * 1024)
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.cohort, 10 * 1024 * 1024)
  assert.equal(ADDITIONAL_HISTORICAL_OWNER_POLICY.source, 6 * 1024 * 1024)
  assert.ok(codeSource.includes('scheduled < POLICY.starts'))
  assert.ok(codeSource.includes("redirect: 'error'"))
  assert.ok(codeSource.includes('holderOriginCodeModule.default?.isEoaTransactionOriginCode'))
  assert.ok(!codeSource.includes('Promise.all('))
})
test('fresh import schedules no configured origins, fetches, timers or CLI', async () => {
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout
  let reads = 0, timers = 0
  globalThis.fetch = async () => { reads++; throw Error('unexpected_read') }
  globalThis.setTimeout = () => { timers++; throw Error('unexpected_timer') }
  try {
    await import('../../scripts/research/morpho-additional-historical-owner-funded-probe.mjs?inert=historical-owner-control')
    assert.equal(reads, 0); assert.equal(timers, 0)
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer }
})


test('privacy visits nested decoded Base64 JSON before textual escapes and escaped keys', () => {
  const secret = 'escapedfixturecredential'
  const escapes = [
    [...secret].map((c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    [...secret].map((c) => '\\u{' + c.charCodeAt(0).toString(16) + '}').join(''),
    [...secret].map((c) => '\\\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    [...secret].map((c) => '\\u005c' + 'x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
  ]
  for (const escaped of escapes) for (const escapedKey of [false, true]) {
    const inner = Buffer.from(JSON.stringify(escapedKey ? { [escaped]: 'innocent' } : { result: escaped })).toString('base64')
    const outer = Buffer.from(JSON.stringify({ rawBodyBase64: inner })).toString('base64')
    assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy({ rawBodyBase64: outer }, [secret]), /credential_echo/)
  }
  assert.equal(assertAdditionalHistoricalOwnerProbePrivacy({ rawBodyBase64: Buffer.from('{"result":"safe"}').toString('base64') }, [secret]), true)
})


test('privacy visits nested decoded JSON whose escaped key becomes a Base64 suffix after the final escape', () => {
  const secret = 'escapedbase64suffixfixturecredential', slash = String.fromCharCode(92)
  const keys = [
    'rawBodyBase' + slash + 'u0036' + '4',
    'rawBodyBase' + slash + 'u{36}' + '4',
    'rawBodyBase' + slash.repeat(2) + 'u0036' + '4',
    'rawBodyBase' + slash + 'u005c' + 'u0036' + '4',
    'rawBodyBase' + slash + 'u005c' + 'u005c' + 'u0036' + '4',
  ]
  for (const key of keys) {
    const inner = Buffer.from(JSON.stringify({ result: 'x:' + secret })).toString('base64')
    assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy({ [key]: inner }, [secret]), /credential_echo/)
    let outer = Buffer.from(JSON.stringify({ [key]: inner })).toString('base64')
    for (let layers = 1; layers <= 3; layers++) {
      assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy({ rawBodyBase64: outer }, [secret]), /credential_echo/)
      outer = Buffer.from(JSON.stringify({ rawBodyBase64: outer })).toString('base64')
    }
  }
  const key = keys[0], safe = Buffer.from(JSON.stringify({ result: 'x:safe' })).toString('base64')
  const outer = Buffer.from(JSON.stringify({ [key]: safe })).toString('base64')
  assert.equal(assertAdditionalHistoricalOwnerProbePrivacy({ rawBodyBase64: outer }, [secret]), true)
  assert.throws(() => assertAdditionalHistoricalOwnerProbePrivacy({ [key]: 'not canonical Base64' }, [secret]), /privacy_raw/)
})
