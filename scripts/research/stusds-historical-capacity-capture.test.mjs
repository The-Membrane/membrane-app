import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  ABI,
  VAT_ABI,
  JUG_ABI,
  CONTRACTS,
  HOSTS,
  POLICY,
  prepareStusdsCapacityPlan,
  validateStusdsCapacityPlan,
  captureStusdsCapacity,
  replayStusdsCapacity,
  writeStusdsCapacityCapture,
  stusdsUnusedFundsArithmetic,
} from './stusds-historical-capacity-capture.mjs'
const hash = (s) => createHash('sha256').update(s).digest('hex'),
  clone = (v) => structuredClone(v),
  reseal = (r) => {
    const { sha256, ...body } = r
    return { ...body, sha256: hash(JSON.stringify(body)) }
  },
  RAY = 10n ** 27n,
  WAD = 10n ** 18n
const vat = '0x' + '1'.repeat(40),
  jug = '0x' + '2'.repeat(40),
  clip = '0x' + '3'.repeat(40),
  ilk = '0x' + '5'.repeat(64)
const origins = HOSTS.map((host) => ({ host, url: 'https://' + host + '/redacted-fixture-key' }))
function fixture() {
  const plan = prepareStusdsCapacityPlan(),
    all = [
      ...plan.anchors.slice(0, 2).map((a) => a.source),
      {
        chainId: 1,
        blockNumber: '26140000',
        blockHash: '0x' + '4'.repeat(64),
        blockTime: '2026-10-07T10:00:00.000Z',
      },
    ]
  let count = 0
  const fetcher = async (url, options) => {
    count++
    assert.equal(options.redirect, 'error')
    const q = JSON.parse(options.body)
    let result
    if (q.method === 'eth_chainId') result = '0x1'
    else if (q.method === 'eth_getBlockByNumber') {
      const h =
        q.params[0] === 'finalized'
          ? all[2]
          : all.find((h) => '0x' + BigInt(h.blockNumber).toString(16) === q.params[0])
      assert.ok(h)
      result = {
        number: '0x' + BigInt(h.blockNumber).toString(16),
        hash: h.blockHash,
        timestamp: '0x' + BigInt(Date.parse(h.blockTime) / 1000).toString(16),
      }
    } else {
      assert.equal(q.params.at(-1).requireCanonical, true)
      const h = all.find((h) => h.blockHash === q.params.at(-1).blockHash)
      assert.ok(h)
      if (q.method === 'eth_getCode') result = '0x60006000'
      else if (q.method === 'eth_getStorageAt')
        result = '0x' + '0'.repeat(24) + CONTRACTS.historicalImplementation.slice(2)
      else {
        const to = q.params[0].to,
          abi =
            to === vat
              ? VAT_ABI
              : to === jug && q.params[0].data.startsWith('0xd9638d36')
                ? JUG_ABI
                : ABI
        let decoded
        try {
          decoded = decodeFunctionData({ abi, data: q.params[0].data })
        } catch {
          decoded = decodeFunctionData({ abi: JUG_ABI, data: q.params[0].data })
        }
        const { functionName, args } = decoded
        let value
        if (functionName === 'ilks') {
          value =
            to === vat
              ? [500n * WAD, RAY, 0n, 0n, 0n]
              : [RAY, BigInt(Date.parse(h.blockTime) / 1000) - 100n]
        } else {
          value = {
            vat,
            jug,
            clip,
            ilk,
            asset: CONTRACTS.usds,
            decimals: 18,
            totalSupply: 1000n * WAD,
            chi: RAY,
            str: RAY,
            rho: BigInt(Date.parse(h.blockTime) / 1000) - 100n,
            convertToAssets: RAY + RAY / 10n,
            balanceOf: 50n * WAD,
            maxWithdraw: 55n * WAD,
            previewRedeem: 55n * WAD,
            base: 0n,
            drip: RAY,
            Due: 100n * WAD * RAY,
          }[functionName]
          if (functionName === 'convertToAssets') assert.equal(args[0], RAY)
          if (functionName === 'previewRedeem') assert.equal(args[0], 50n * WAD)
          if (functionName === 'ilks' || functionName === 'drip') assert.equal(args[0], ilk)
        }
        result = encodeFunctionResult({
          abi: functionName === 'ilks' ? (to === vat ? VAT_ABI : JUG_ABI) : ABI,
          functionName,
          result: value,
        })
      }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }))
  }
  return { plan, fetcher, count: () => count }
}
let receipt, plan
await test('fixed saved SHA-linked sources retain distinct historical owners and190-start bound', () => {
  plan = prepareStusdsCapacityPlan()
  assert.equal(validateStusdsCapacityPlan(plan).expectedStarts, 190)
  assert.equal(
    validateStusdsCapacityPlan(prepareStusdsCapacityPlan({ includeCurrent: false })).expectedStarts,
    128,
  )
  assert.notEqual(plan.anchors[0].owner, plan.anchors[1].owner)
  assert.ok(Object.isFrozen(plan.anchors[0].source))
  const bad = clone(plan)
  bad.anchors[0].owner = bad.anchors[1].owner
  assert.throws(() => validateStusdsCapacityPlan(bad))
  assert.throws(() => prepareStusdsCapacityPlan({ includeCurrent: ['true'] }))
})
await test('capture snapshots approved endpoint primitives before caller mutation across awaits', async () => {
  const f = fixture(),
    callerOrigins = HOSTS.map((host, i) => ({
      host,
      url: 'https://' + host + '/caller-private-key-' + i,
    })),
    approvedUrls = callerOrigins.map((o) => o.url),
    seen = []
  const callerObjects = [...callerOrigins]
  const captured = await captureStusdsCapacity(f.plan, callerOrigins, {
    fetcher: async (url, options) => {
      seen.push(url)
      if (seen.length === 1) {
        for (const o of callerObjects) {
          o.host = 'unapproved.example'
          o.url = 'https://unapproved.example/foreign-secret'
        }
        callerOrigins.reverse()
        callerOrigins.splice(0, callerOrigins.length, {
          host: 'other.example',
          url: 'https://other.example/another-secret',
        })
      }
      assert.ok(approvedUrls.includes(url))
      return f.fetcher(url, options)
    },
  })
  assert.equal(seen.length, 190)
  for (const url of approvedUrls) assert.equal(seen.filter((v) => v === url).length, 95)
  const encoded = JSON.stringify(captured)
  for (const secret of [
    'caller-private-key',
    'foreign-secret',
    'another-secret',
    'unapproved.example',
    'other.example',
  ])
    assert.equal(encoded.includes(secret), false)
  const replay = replayStusdsCapacity(captured, f.plan)
  assert.equal(replay.current.status, 'conditional_contract_reported_prongs')
})
await test('actual mocked190 requests retain raw prongs with changed-runtime derivation censored', async () => {
  const f = fixture()
  receipt = await captureStusdsCapacity(f.plan, origins, { fetcher: f.fetcher })
  assert.equal(f.count(), 190)
  const out = replayStusdsCapacity(receipt, plan)
  assert.equal(out.history.points.length, 2)
  assert.deepEqual(out.history.elapsedSeconds, [0, 1152])
  assert.equal(out.history.sameHolder, false)
  for (const point of [...out.history.points, out.current]) {
    assert.equal(point.status, 'conditional_contract_reported_prongs')
    assert.equal(point.globalProngs.vatArtRaw, String(500n * WAD))
    assert.equal(point.globalProngs.clipDueRaw, String(100n * WAD * RAY))
    assert.equal(point.globalProngs.chiNowRaw, String(RAY + RAY / 10n))
    assert.equal(point.globalProngs.unusedFundsBurnRaw, null)
    assert.equal(point.globalProngs.unusedFundsGetterRaw, null)
    assert.equal(point.globalProngs.retainedImplementationMatches, false)
    assert.equal(point.holderQuote.fullPositionEntitlementRaw, String(55n * WAD))
    assert.equal(point.holderQuote.quotedMinRuleMatches, null)
  }
  assert.equal(out.capacityTranslationEligible, false)
  assert.equal(out.holderExecutableExit, false)
  assert.ok(!JSON.stringify(receipt).includes('redacted-fixture-key'))
  assert.ok(Object.isFrozen(out.current.globalProngs))
})
await test('native unused-funds arithmetic separates debt andDue, clampsnegative, rejectsoverflow/primitives', () => {
  const input = {
    supplyRaw: String(1000n * WAD),
    chiNowRaw: String(RAY + RAY / 10n),
    artRaw: String(500n * WAD),
    rateRaw: String(RAY),
    dueRaw: String(100n * WAD * RAY),
  }
  assert.equal(stusdsUnusedFundsArithmetic(input), String(500n * WAD))
  assert.equal(stusdsUnusedFundsArithmetic({ ...input, artRaw: String(1500n * WAD) }), '0')
  assert.equal(
    stusdsUnusedFundsArithmetic({ ...input, supplyRaw: String((1n << 256n) - 1n) }),
    null,
  )
  assert.equal(stusdsUnusedFundsArithmetic({ ...input, rateRaw: [String(RAY)] }), null)
})
await test('optional owner quote failure or disagreement retains independently agreed globalprongs', () => {
  for (const key of ['ownerMaxWithdraw', 'ownerFullEntitlement']) {
    const r = clone(receipt)
    r.traces.find((t) => t.key === key).response = { error: { code: 3 } }
    const out = replayStusdsCapacity(reseal(r), plan)
    assert.ok(out.history.points[0].globalProngs)
    assert.equal(out.history.points[0].holderQuote, null)
    assert.ok(out.history.points[1].holderQuote)
  }
  const r = clone(receipt)
  r.traces.find((t) => t.key === 'ownerMaxWithdraw').response.result = encodeFunctionResult({
    abi: ABI,
    functionName: 'maxWithdraw',
    result: 0n,
  })
  assert.equal(replayStusdsCapacity(reseal(r), plan).history.points[0].holderQuote, null)
})
await test('dependent code changes remain raw and explicitly fail cross-historyregime qualification', () => {
  const r = clone(receipt)
  for (const t of r.traces.filter((t) => t.anchor === 1 && t.key === 'code_jug'))
    t.response.result = '0x60016000'
  const out = replayStusdsCapacity(reseal(r), plan)
  assert.ok(out.history.points[1].globalProngs)
  assert.equal(out.historyRegimeMatch, false)
  assert.equal(out.currentRegimeMatchesHistory, false)
  assert.equal(out.capacityTranslationEligible, false)
})
await test('wrongunits/ilk/dependentidentity clearglobal facts, not fabricated zero', () => {
  for (const key of ['assetDecimals', 'clipIlk', 'jugVat']) {
    const r = clone(receipt)
    const result =
      key === 'assetDecimals'
        ? encodeFunctionResult({ abi: ABI, functionName: 'decimals', result: 6 })
        : key === 'clipIlk'
          ? encodeFunctionResult({ abi: ABI, functionName: 'ilk', result: '0x' + '9'.repeat(64) })
          : encodeFunctionResult({ abi: ABI, functionName: 'vat', result: clip })
    for (const t of r.traces.filter((t) => t.key === key)) t.response.result = result
    const out = replayStusdsCapacity(reseal(r), plan)
    assert.equal(out.current.globalProngs, null)
    assert.equal(out.current.status, 'incomplete')
  }
})
await test('sourcepin/clock/budget/derivedmethod mutations cannot replay', () => {
  for (const mutate of [
    (r) =>
      (r.traces.find((t) => t.key === 'burnRateNow').request.params[1].requireCanonical = false),
    (r) => (r.traces.find((t) => t.key === 'chiNow').request.params[0].data = '0x'),
    (r) =>
      (r.traces[0].completedAt = new Date(Date.parse(r.traces[0].startedAt) + 8251).toISOString()),
    (r) => (r.policy.maxRequests = 191),
    (r) =>
      (r.traces.find((t) => t.key === 'code_proxy').response.result = '0x' + '00'.repeat(131073)),
    (r) => (r.sources[2].blockHash = '0x' + '0'.repeat(64)),
  ]) {
    const r = clone(receipt)
    mutate(r)
    assert.throws(() => replayStusdsCapacity(reseal(r), plan))
  }
})
await test('exclusive secret-free writer preserves existingbytes and enforcesreserve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stusds-capture-'))
  try {
    const p = join(dir, 'proof.json'),
      statfs = () => ({ bavail: 2 * POLICY.reserveBytes, bsize: 1 })
    writeStusdsCapacityCapture(p, receipt, { statfs })
    const b = readFileSync(p)
    assert.throws(() => writeStusdsCapacityCapture(p, receipt, { statfs }), /EEXIST/)
    assert.deepEqual(readFileSync(p), b)
    assert.throws(
      () =>
        writeStusdsCapacityCapture(
          join(dir, 'secret.json'),
          { endpoint: 'https://secret/key' },
          { statfs },
        ),
      /artifact_url/,
    )
    assert.throws(
      () =>
        writeStusdsCapacityCapture(join(dir, 'low.json'), receipt, {
          statfs: () => ({ bavail: POLICY.reserveBytes, bsize: 1 }),
        }),
      /disk_reserve/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
await test('unsettled abortion stops newlaunches and retains typedincomplete receipt', async () => {
  let starts = 0
  const r = await captureStusdsCapacity(plan, origins, {
    rpcTimeoutMs: 1,
    fetcher: async () => {
      starts++
      return new Promise(() => {})
    },
  })
  assert.equal(starts, 2)
  assert.equal(r.captureClosedReason, 'rpc_abort_unsettled')
  const out = replayStusdsCapacity(r, plan)
  assert.equal(out.current.status, 'incomplete')
})
