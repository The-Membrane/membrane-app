import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodeFunctionResult } from 'viem'
import {
  FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES as FILES,
  FLUID_USDT_COMPOSED_HISTORY_ANCHORS as ANCHORS,
  FLUID_USDT_COMPOSED_HISTORY_LIMITS as LIMITS,
  createFluidUsdtComposedHistoricalContext as makeContext,
  prepareFluidUsdtComposedHistoricalOriginals as prepare,
  fluidUsdtComposedHistoricalReadPlan as plan,
  replayFluidUsdtComposedHistoricalEvidence as replay,
} from '../../lib/carry/fluidUsdtBridgeJointComposedHistoricalEvidenceCodec'
import { FLUID_USDC_BRIDGE_NATIVE_ABI } from '../../lib/carry/fluidUsdcBridgeNativeAbi'
import { resolveFluidUsdcBridgeJointTrustedProfile } from '../../lib/carry/fluidUsdcBridgeJointTrustedProfile'
import {
  FLUID_USDT_QUOTE_ABI,
  FLUID_USDT_QUOTE_CONTRACTS as C,
  FLUID_USDT_QUOTE_HOSTS as HOSTS,
} from '../../lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec'
import {
  encodeFluidUsdcBridgeJointNativeHistoryEvidence,
  decodeFluidUsdcBridgeJointNativeHistoryEvidence,
} from '../../lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec'

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const iso = (n: number) => new Date(n).toISOString()
const BASE = Date.parse('2026-10-09T08:00:00.000Z')
const S = '5719789502600562945608',
  Q = '1000000',
  R = '999511',
  Ea = '6005678047'
const profile = resolveFluidUsdcBridgeJointTrustedProfile(
  'USDC → FluidBridgeAggregatorProxy [USDC]',
  '0x273da948aca9261043fbdb2a857bc255ecc29012',
  C.usdc,
)!
const runtimes = {
  ...profile.runtimeCodeHashes,
  [C.factory]: '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69',
  [C.quoter]: '0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b',
  [C.pool]: '0x2ff673bacc60a73fc85c678888296c6bce3de2a9d7475c032fe7aa6e0eacba86',
  [C.usdt]: '0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55',
}
const ctx = makeContext({
  sharesRaw: S,
  requestedFinalUsdtRaw: Q,
  currentSource: {
    chainId: 1,
    blockNumber: 26152926,
    blockHash: '0x7b1c926b58b53a1f413bd54173bb674cec9cfa3d7edbe411e7dc03ce710953cd',
    blockTime: '2026-10-09T06:01:59.000Z',
    finalized: true,
  },
  profileId: 'fluid-usdt-bridge-same-pool-quote-funding-v1',
  runtimeCodeHashes: runtimes,
  owner: null,
  historicalOwnership: false,
})!
let originals: any[] | undefined, prepared: any
function rawOriginals() {
  if (!originals)
    originals = FILES.map((d) => {
      const rawText = readFileSync(resolve(process.cwd(), d.path), 'utf8')
      assert.equal(Buffer.byteLength(rawText), d.bytes)
      assert.equal(sha(rawText), d.fileSha256)
      return { descriptorId: d.id, rawText }
    })
  return originals
}
function originalPreparation() {
  if (!prepared) prepared = prepare(rawOriginals(), ctx)
  assert.ok(prepared, 'all fixed original native proofs must admit independently')
  return prepared
}
function reseal(batch: any) {
  batch.receipt.terminalCommitments = batch.receipt.ledger.map((row: any) => ({
    physicalId: row.physicalId,
    rowSha256: sha(JSON.stringify(row)),
  }))
  batch.settlements = batch.receipt.ledger.map((row: any) => {
    const body = {
      schema: 'usd3_hypothetical_physical_settlement_v1',
      physicalId: row.physicalId,
      captureAcceptance: false,
      observation: clone(row),
    }
    return { ...body, sha256: sha(JSON.stringify(body)) }
  })
}
function changeResponse(batch: any, row: any, result: any) {
  const response = { jsonrpc: '2.0', id: row.request.id, result },
    text = JSON.stringify(response)
  row.rawBodyBase64 = Buffer.from(text).toString('base64')
  row.bodyBytes = Buffer.byteLength(text)
  row.bodySha256 = sha(text)
  reseal(batch)
}
function rewriteRequest(batch: any, row: any, change: (r: any) => void) {
  change(row.request)
  const meta = batch.requests.find((r: any) => r.host === row.host && r.rpcId === row.request.id)
  const text = JSON.stringify(row.request)
  meta.requestBodyBase64 = Buffer.from(text).toString('base64')
  meta.requestBodySha256 = sha(text)
  reseal(batch)
}
function fixture(context = ctx, required = R, roundtrip = Q, entitlement = Ea) {
  // Only the old originals are observations. All new responses below are controlled,
  // unsigned ABI fixtures. They do not establish historical ownership or live issuance.
  const batches = [0, 1].map((b) => {
    const started = BASE + b * 100000,
      ledger: any[] = [],
      requests: any[] = []
    function add(
      host: string,
      j: number,
      cashIndex: number | null,
      spec: any,
      result: any,
      ordinal: number,
    ) {
      const id = ledger.length + 1,
        start = started + 100 + ordinal * 300 + j * 10,
        end = start + 25
      const request = {
          jsonrpc: '2.0',
          id,
          method: spec.request.method,
          params: clone(spec.request.params),
        },
        text = JSON.stringify(request)
      const responseText = JSON.stringify({ jsonrpc: '2.0', id, result })
      requests.push({
        host,
        cashIndex,
        key: spec.key,
        rpcId: id,
        requestBodyBase64: Buffer.from(text).toString('base64'),
        requestBodySha256: sha(text),
      })
      ledger.push({
        physicalId: id,
        host,
        stage: cashIndex === null ? 'usdt_history_chain' : 'usdt_history_' + cashIndex,
        request,
        startedAtUtc: iso(start),
        startedElapsedMs: start - started,
        completedAtUtc: iso(end),
        completedElapsedMs: end - started,
        status: 'success',
        httpStatus: 200,
        bodyBytes: Buffer.byteLength(responseText),
        bodySha256: sha(responseText),
        rawBodyBase64: Buffer.from(responseText).toString('base64'),
        safeCode: null,
        accepted: true,
      })
    }
    HOSTS.forEach((h, j) =>
      add(h, j, null, { key: 'chain', request: { method: 'eth_chainId', params: [] } }, '0x1', 0),
    )
    ANCHORS.slice(b * 4, b * 4 + 4).forEach((a, n) => {
      const specs = plan(context, a.cashIndex, required)
      specs.forEach((spec, k) =>
        HOSTS.forEach((h, j) => {
          let result: any
          if (spec.key.startsWith('header_'))
            result = {
              number: '0x' + a.source.blockNumber.toString(16),
              hash: a.source.blockHash,
              timestamp: '0x' + BigInt(Date.parse(a.source.blockTime) / 1000).toString(16),
            }
          else
            result = encodeFunctionResult({
              abi: spec.key === 'full_net_ea' ? FLUID_USDC_BRIDGE_NATIVE_ABI : FLUID_USDT_QUOTE_ABI,
              functionName:
                spec.key === 'full_net_ea'
                  ? 'previewRedeem'
                  : spec.key === 'required_usdc'
                    ? 'quoteExactOutputSingle'
                    : 'quoteExactInputSingle',
              result:
                spec.key === 'full_net_ea'
                  ? BigInt(entitlement)
                  : [BigInt(spec.key === 'required_usdc' ? required : roundtrip), 1n, 0, 1n],
            } as any)
          add(h, j, a.cashIndex, spec, result, 1 + n * 5 + k)
        }),
      )
    })
    const receipt = {
      startedAtUtc: iso(started),
      availableAtUtc: iso(started + 6500),
      elapsedMs: 6500,
      physicalStarts: 42,
      pendingSettlements: 0,
      failure: null,
      ledger,
      terminalCommitments: [],
    }
    const batch = {
      controlNamespace: 'controlled_history_' + b,
      receipt,
      requests,
      settlements: [],
      availableAtUtc: iso(started + 6600),
    }
    reseal(batch)
    return batch
  })
  return {
    schema: 'fluid_usdt_composed_history_raw_v1',
    preparedOriginals: originalPreparation(),
    batches,
    seriesAvailableAtUtc: batches[1].availableAtUtc,
  }
}
const rowFor = (wire: any, key: string, host = HOSTS[0]) => {
  const b = wire.batches[0],
    meta = b.requests.find((r: any) => r.key === key && r.host === host && r.cashIndex === 111)
  return {
    batch: b,
    row: b.receipt.ledger.find((r: any) => r.host === host && r.request.id === meta.rpcId),
    meta,
  }
}
test('sixteen literal originals retain 21,894,511 actual UTF8 bytes with per-file and separate UTF16 admission', () => {
  assert.equal(FILES.length, 16)
  assert.equal(
    FILES.reduce((n, d) => n + d.bytes, 0),
    21894511,
  )
  assert.ok(FILES.every((d) => d.bytes <= LIMITS.originalFileBytes))
  assert.ok(rawOriginals().reduce((n, o) => n + o.rawText.length * 2, 0) > 32 * 1024 * 1024)
  assert.ok(originalPreparation())
  assert.equal(prepared.originalAuthority, false)
  assert.equal(prepared.authenticated, false)
})
test('old source chronological order cannot retime reverse acquisition clocks to pass a combined old decoder', () => {
  const a = JSON.parse(rawOriginals()[0].rawText),
    b = JSON.parse(rawOriginals()[1].rawText)
  assert.ok(Date.parse(a.availableAtUtc) > Date.parse(b.availableAtUtc))
  assert.throws(
    () =>
      decodeFluidUsdcBridgeJointNativeHistoryEvidence(
        encodeFluidUsdcBridgeJointNativeHistoryEvidence([a, b]),
      ),
    /fluid_bridge_native_evidence_invalid/,
  )
  assert.ok(originalPreparation())
})
test('eight same-S/Q frames contain original prongs with fresh native newS Ea/R/roundtrip, without authority', () => {
  const result = replay(fixture(), ctx)!
  assert.ok(result)
  assert.equal(result.points.length, 8)
  assert.deepEqual(
    result.points.map((p) => p.source.blockNumber),
    ANCHORS.map((a) => String(a.source.blockNumber)),
  )
  assert.ok(
    result.points.every(
      (p) =>
        p.holderSharesRaw === S &&
        p.fullHolderNetUsdcRaw === Ea &&
        p.conversion.requiredNetUsdcRaw === R &&
        p.conversion.fixedFinalUsdtOutputRaw === Q &&
        p.owner === null &&
        !p.historicalOwnership,
    ),
  )
  assert.equal(result.acquiredAtUtc, iso(BASE + 106135))
  assert.equal(result.availableAtUtc, iso(BASE + 106600))
  assert.equal(result.originalAuthority, false)
  assert.equal(result.authenticated, false)
  assert.equal(result.executionQualified, false)
  assert.equal(result.calibrated, false)
  assert.equal(result.sourceImplementationEquivalence, false)
  assert.equal(result.MRaw, null)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.points[0].nativeProngs))
})
test('fresh Q/cost/native Ea are independent from old tinyS and old three USDT quotes', () => {
  const c = makeContext({
    ...ctx,
    sharesRaw: '999000000000000000000',
    requestedFinalUsdtRaw: '5000000',
  })!
  const r = replay(fixture(c, '4997000', '5000000', '1040000000'), c)!
  assert.ok(r)
  assert.equal(r.sharesRaw, c.sharesRaw)
  assert.equal(r.points[0].fullHolderNetUsdcRaw, '1040000000')
  assert.equal(r.points[0].conversion.requiredNetUsdcRaw, '4997000')
  assert.equal(JSON.parse(rawOriginals()[0].rawText).plan.subject.sharesRaw, '967573479322309282')
})
test('serialized or shallow cloned unsigned preparation never bypasses original validation', () => {
  const w = fixture()
  w.preparedOriginals = clone(w.preparedOriginals)
  assert.equal(replay(w, ctx), null)
  w.preparedOriginals = { ...originalPreparation() }
  assert.equal(replay(w, ctx), null)
})
test('caller facts, private paths, or a claimed authenticated prepare handle cannot substitute raw fixed originals', () => {
  assert.equal(prepare({ points: [] }, ctx), null)
  const w = fixture()
  w.preparedOriginals = {
    schema: 'fluid_usdt_composed_unsigned_preparation_v1',
    originalAuthority: true,
    authenticated: true,
  }
  assert.equal(replay(w, ctx), null)
})
test('original record and array getters reject without invoking accessors', () => {
  let calls = 0
  const rows = rawOriginals().slice()
  rows[0] = Object.defineProperty({ descriptorId: FILES[0].id }, 'rawText', {
    enumerable: true,
    get() {
      calls++
      return rawOriginals()[0].rawText
    },
  })
  assert.equal(prepare(rows, ctx), null)
  assert.equal(calls, 0)
  const arr = rawOriginals().slice()
  Object.defineProperty(arr, 0, {
    enumerable: true,
    get() {
      calls++
      return rawOriginals()[0]
    },
  })
  assert.equal(prepare(arr, ctx), null)
  assert.equal(calls, 0)
})
test('fixed descriptor byte/hash guards reject mutation, duplicate, missing, path-shaped substitution, and extra fields', () => {
  const rows = rawOriginals().slice()
  rows[0] = { ...rows[0], rawText: rows[0].rawText + ' ' }
  assert.equal(prepare(rows, ctx), null)
  rows[0] = rows[1]
  assert.equal(prepare(rows, ctx), null)
  assert.equal(prepare(rawOriginals().slice(1), ctx), null)
  rows[0] = { descriptorId: FILES[0].path, rawText: rawOriginals()[0].rawText }
  assert.equal(prepare(rows, ctx), null)
  rows[0] = { ...rawOriginals()[0], authenticated: true }
  assert.equal(prepare(rows, ctx), null)
})
test('resealed invalid old original cannot replace immutable FILE pin', () => {
  const rows = rawOriginals().slice(),
    old = JSON.parse(rows[0].rawText)
  old.plan.subject.sharesRaw = S
  const { sha256: _, ...body } = old
  old.sha256 = sha(JSON.stringify(body))
  rows[0] = { ...rows[0], rawText: JSON.stringify(old) }
  assert.equal(prepare(rows, ctx), null)
})
test('closed context rejects ownership, runtime/fee-profile/unit substitute, zero/overflow S/Q, and source at old anchor', () => {
  const changes = [
    { owner: '0x' + '1'.repeat(40) },
    { historicalOwnership: true },
    { profileId: 'caller-approved' },
    { sharesRaw: '0' },
    { requestedFinalUsdtRaw: '0' },
    { sharesRaw: (1n << 256n).toString() },
    { requestedFinalUsdtRaw: '1000000.0' },
    { runtimeCodeHashes: { ...runtimes, [C.usdt]: '0x' + '0'.repeat(64) } },
    { currentSource: ANCHORS[7].source },
  ]
  for (const c of changes) assert.equal(makeContext({ ...ctx, ...c }), null)
})
test('plan exact newS preview and staged positive R use canonical block hash only', () => {
  const first = plan(ctx, 111)
  assert.equal(first.length, 3)
  const full = plan(ctx, 111, R)
  assert.equal(full.length, 5)
  assert.deepEqual(
    full.filter((s) => s.request.method === 'eth_call').map((s) => s.request.params[1]),
    Array(3).fill({ blockHash: ANCHORS[0].source.blockHash, requireCanonical: true }),
  )
  assert.throws(() => plan(ctx, 111, '0'))
  assert.throws(() => plan(ctx, 119, R))
})
test('native roundtrip below requested output censors even after all raw row and settlement reseals', () => {
  const w = fixture(ctx, R, '999999')
  assert.equal(replay(w, ctx), null)
})
test('zero native required cost never qualifies', () => {
  const w = fixture(),
    { batch, row } = rowFor(w, 'required_usdc')
  changeResponse(
    batch,
    row,
    encodeFunctionResult({
      abi: FLUID_USDT_QUOTE_ABI,
      functionName: 'quoteExactOutputSingle',
      result: [0n, 1n, 0, 1n],
    }),
  )
  assert.equal(replay(w, ctx), null)
})
test('Q and S changes require fresh exact calldata and cannot reuse prior dynamic rows', () => {
  const w = fixture()
  assert.equal(replay(w, makeContext({ ...ctx, sharesRaw: '42' })), null)
  assert.equal(replay(w, makeContext({ ...ctx, requestedFinalUsdtRaw: '999999' })), null)
})
test('resealed source number fallback and wrong canonical hash cannot join native old prongs', () => {
  for (const change of [
    (r: any) => {
      r.params[1] = '0x18d80bc'
    },
    (r: any) => {
      r.params[1] = { blockHash: '0x' + '2'.repeat(64), requireCanonical: true }
    },
  ]) {
    const w = fixture(),
      { batch, row } = rowFor(w, 'full_net_ea')
    rewriteRequest(batch, row, change)
    assert.equal(replay(w, ctx), null)
  }
})
test('origin disagreement in Ea and R invalidates same-frame composition', () => {
  for (const key of ['full_net_ea', 'required_usdc']) {
    const w = fixture(),
      { batch, row } = rowFor(w, key)
    const result =
      key === 'full_net_ea'
        ? encodeFunctionResult({
            abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
            functionName: 'previewRedeem',
            result: 1n,
          })
        : encodeFunctionResult({
            abi: FLUID_USDT_QUOTE_ABI,
            functionName: 'quoteExactOutputSingle',
            result: [999500n, 1n, 0, 1n],
          })
    changeResponse(batch, row, result)
    assert.equal(replay(w, ctx), null)
  }
})
test('header B/hash/time mismatch is rejected independently of valid quote responses', () => {
  const w = fixture(),
    { batch, row } = rowFor(w, 'header_after')
  changeResponse(batch, row, { number: '0x18d80bc', hash: '0x' + '4'.repeat(64), timestamp: '0x1' })
  assert.equal(replay(w, ctx), null)
})
test('duplicate namespaces, duplicate physical joins, wrong logical anchor, missing native chain are rejected', () => {
  for (const mutate of [
    (w: any) => {
      w.batches[1].controlNamespace = w.batches[0].controlNamespace
    },
    (w: any) => {
      w.batches[0].requests[1] = clone(w.batches[0].requests[0])
    },
    (w: any) => {
      w.batches[0].requests[2].cashIndex = 115
    },
    (w: any) => {
      w.batches[0].requests[0].key = 'not_chain'
    },
  ]) {
    const w = fixture()
    mutate(w)
    assert.equal(replay(w, ctx), null)
  }
})
test('raw bytes, request commitment, terminal row commitment, and captured settlement mutation cannot qualify', () => {
  for (const mutate of [
    (w: any) => {
      w.batches[0].receipt.ledger[2].rawBodyBase64 = 'e30='
    },
    (w: any) => {
      w.batches[0].requests[2].requestBodySha256 = '0'.repeat(64)
    },
    (w: any) => {
      w.batches[0].receipt.terminalCommitments[2].rowSha256 = '0'.repeat(64)
    },
    (w: any) => {
      w.batches[0].settlements[2].sha256 = '0'.repeat(64)
    },
  ]) {
    const w = fixture()
    mutate(w)
    assert.equal(replay(w, ctx), null)
  }
})
test('JSONRPC response id and actual request id cannot substitute another read', () => {
  const w = fixture(),
    { batch, row } = rowFor(w, 'full_net_ea')
  const text = JSON.stringify({
    jsonrpc: '2.0',
    id: 999,
    result: encodeFunctionResult({
      abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
      functionName: 'previewRedeem',
      result: BigInt(Ea),
    }),
  })
  row.rawBodyBase64 = Buffer.from(text).toString('base64')
  row.bodyBytes = Buffer.byteLength(text)
  row.bodySha256 = sha(text)
  reseal(batch)
  assert.equal(replay(w, ctx), null)
})
test('native errors, pending/failed receipts, and truncated successful metadata stay censored', () => {
  for (const mutate of [
    (w: any) => {
      w.batches[0].receipt.failure = 'read_timeout'
    },
    (w: any) => {
      w.batches[0].receipt.pendingSettlements = 1
    },
    (w: any) => {
      w.batches[0].receipt.ledger.pop()
    },
    (w: any) => {
      w.batches[0].receipt.ledger[2].accepted = false
      reseal(w.batches[0])
    },
  ]) {
    const w = fixture()
    mutate(w)
    assert.equal(replay(w, ctx), null)
  }
})
test('completion/read/source clock order and post-retention availability remain distinct', () => {
  const w = fixture()
  w.batches[0].availableAtUtc = w.batches[0].receipt.startedAtUtc
  assert.equal(replay(w, ctx), null)
  const a = fixture(),
    { batch, row } = rowFor(a, 'full_net_ea')
  row.completedAtUtc = iso(BASE - 1)
  reseal(batch)
  assert.equal(replay(a, ctx), null)
  const b = fixture()
  b.batches[0].availableAtUtc = iso(BASE + 10000)
  const result = replay(b, ctx)!
  assert.ok(result)
  assert.equal(result.points[0].availableAtUtc, b.seriesAvailableAtUtc)
  assert.ok(
    Date.parse(result.points[0].acquiredAtUtc) < Date.parse(result.points[0].availableAtUtc),
  )
})
test('controlled dynamic data preserve all old file bytes and original acquisition clocks', () => {
  const before = rawOriginals().map((o) => sha(o.rawText)),
    result = replay(fixture(), ctx)
  assert.ok(result)
  assert.deepEqual(
    rawOriginals().map((o) => sha(o.rawText)),
    before,
  )
  assert.equal(JSON.parse(rawOriginals()[0].rawText).availableAtUtc, '2026-10-08T11:15:59.185Z')
  assert.equal(JSON.parse(rawOriginals()[1].rawText).availableAtUtc, '2026-10-08T10:42:20.921Z')
})
test('top-level and dynamic getters do not run and snapshots reject cycles or exotic prototypes', () => {
  let calls = 0
  const w = fixture()
  Object.defineProperty(w, 'batches', {
    enumerable: true,
    get() {
      calls++
      throw Error('must not read')
    },
  })
  assert.equal(replay(w, ctx), null)
  assert.equal(calls, 0)
  const a = fixture()
  a.batches[0].receipt.loop = a
  assert.equal(replay(a, ctx), null)
  const b = fixture()
  Object.setPrototypeOf(b.batches[0], null)
  assert.equal(replay(b, ctx), null)
})

test('observed old post-retention floor cannot be erased by an early controlled new capture', () => {
  const w = fixture(),
    delta = BASE - Date.parse('2026-10-09T04:40:00.000Z')
  for (const batch of w.batches) {
    batch.receipt.startedAtUtc = iso(Date.parse(batch.receipt.startedAtUtc) - delta)
    batch.receipt.availableAtUtc = iso(Date.parse(batch.receipt.availableAtUtc) - delta)
    batch.availableAtUtc = iso(Date.parse(batch.availableAtUtc) - delta)
    for (const row of batch.receipt.ledger) {
      row.startedAtUtc = iso(Date.parse(row.startedAtUtc) - delta)
      row.completedAtUtc = iso(Date.parse(row.completedAtUtc) - delta)
    }
    reseal(batch)
  }
  w.seriesAvailableAtUtc = iso(Date.parse(w.seriesAvailableAtUtc) - delta)
  assert.equal(replay(w, ctx), null)
})

test('per-file UTF8 and isolated UTF16 caps reject before parsing oversized primitive originals', () => {
  const rows = rawOriginals().slice()
  rows[0] = { descriptorId: FILES[0].id, rawText: 'é'.repeat(4 * 1024 * 1024 + 1) }
  assert.equal(prepare(rows, ctx), null)
  rows[0] = { descriptorId: FILES[0].id, rawText: 'x'.repeat(8 * 1024 * 1024 + 1) }
  assert.equal(prepare(rows, ctx), null)
  assert.equal(LIMITS.totalOriginalBytes, 32 * 1024 * 1024)
  assert.equal(
    FILES.reduce((n, d) => n + d.bytes, 0),
    21894511,
  )
})
test('resealed wrong dynamic stage cannot masquerade as an anchor read', () => {
  const w = fixture(),
    { batch, row } = rowFor(w, 'full_net_ea')
  row.stage = 'usdt_history_112'
  reseal(batch)
  assert.equal(replay(w, ctx), null)
})
test('reusable unsigned preparation binds cloned exact context but grants no pointer authority', () => {
  const c = makeContext(clone(ctx))!,
    result = replay(fixture(c), c)
  assert.ok(result)
  assert.equal(result.authenticated, false)
  assert.equal(result.originalAuthority, false)
})

test('observed per-host spacing, monotonic UTC coherence, and exact stage bounds reject resealed mutations', () => {
  const w = fixture(),
    { batch, row } = rowFor(w, 'full_net_ea')
  const delta = 150
  row.startedElapsedMs -= delta
  row.completedElapsedMs -= delta
  row.startedAtUtc = iso(Date.parse(row.startedAtUtc) - delta)
  row.completedAtUtc = iso(Date.parse(row.completedAtUtc) - delta)
  reseal(batch)
  assert.equal(replay(w, ctx), null)
  const a = fixture(),
    target = rowFor(a, 'full_net_ea')
  target.row.startedAtUtc = iso(Date.parse(target.row.startedAtUtc) + 3)
  reseal(target.batch)
  assert.equal(replay(a, ctx), null)
  const b = fixture(),
    last = b.batches[0]
  for (const r of last.receipt.ledger.filter(
    (r: any) => r.stage === 'usdt_history_114' && r.request.method === 'eth_getBlockByNumber',
  )) {
    const metadata = last.requests.find((m: any) => m.rpcId === r.request.id)
    if (metadata.key !== 'header_after') continue
    r.startedElapsedMs += 13000
    r.completedElapsedMs += 13000
    r.startedAtUtc = iso(Date.parse(r.startedAtUtc) + 13000)
    r.completedAtUtc = iso(Date.parse(r.completedAtUtc) + 13000)
  }
  last.receipt.elapsedMs = 20000
  last.receipt.availableAtUtc = iso(BASE + 20000)
  last.availableAtUtc = iso(BASE + 20100)
  reseal(last)
  assert.equal(replay(b, ctx), null)
})
test('two new batches must be ordered and complete within their observed120s interval', () => {
  for (const delta of [-100000, 20000]) {
    const w = fixture(),
      b = w.batches[1]
    b.receipt.startedAtUtc = iso(Date.parse(b.receipt.startedAtUtc) + delta)
    b.receipt.availableAtUtc = iso(Date.parse(b.receipt.availableAtUtc) + delta)
    b.availableAtUtc = iso(Date.parse(b.availableAtUtc) + delta)
    for (const row of b.receipt.ledger) {
      row.startedAtUtc = iso(Date.parse(row.startedAtUtc) + delta)
      row.completedAtUtc = iso(Date.parse(row.completedAtUtc) + delta)
    }
    reseal(b)
    w.seriesAvailableAtUtc = iso(Date.parse(w.seriesAvailableAtUtc) + delta)
    assert.equal(replay(w, ctx), null)
  }
})

test('new capture starts at or after original retention, including a one-millisecond boundary', () => {
  const floor = Date.parse('2026-10-09T04:42:24.260Z')
  for (const offset of [-1, 0]) {
    const w = fixture(),
      delta = BASE - floor - offset
    for (const batch of w.batches) {
      batch.receipt.startedAtUtc = iso(Date.parse(batch.receipt.startedAtUtc) - delta)
      batch.receipt.availableAtUtc = iso(Date.parse(batch.receipt.availableAtUtc) - delta)
      batch.availableAtUtc = iso(Date.parse(batch.availableAtUtc) - delta)
      for (const row of batch.receipt.ledger) {
        row.startedAtUtc = iso(Date.parse(row.startedAtUtc) - delta)
        row.completedAtUtc = iso(Date.parse(row.completedAtUtc) - delta)
      }
      reseal(batch)
    }
    w.seriesAvailableAtUtc = iso(Date.parse(w.seriesAvailableAtUtc) - delta)
    assert.ok(Date.parse(w.batches[0].availableAtUtc) > floor)
    const result = replay(w, ctx)
    if (offset === -1) assert.equal(result, null)
    else assert.ok(result)
  }
})

test('final series barrier is required, canonical and no earlier than every retained batch', () => {
  for (const invalid of [
    undefined,
    null,
    '2026-10-09T08:00:00Z',
    'not-a-clock',
    iso(BASE + 100000),
    '2026-10-09T04:42:24.259Z',
  ]) {
    const w: any = fixture()
    if (invalid === undefined) delete w.seriesAvailableAtUtc
    else w.seriesAvailableAtUtc = invalid
    assert.equal(replay(w, ctx), null)
  }
})
test('later final retention barrier updates only frame availability and preserves every native and batch clock', () => {
  const w = fixture(),
    before = JSON.stringify(w.batches),
    native = replay(w, ctx)!
  assert.ok(native)
  w.seriesAvailableAtUtc = iso(BASE + 108600)
  const result = replay(w, ctx)!
  assert.ok(result)
  assert.equal(result.availableAtUtc, w.seriesAvailableAtUtc)
  assert.ok(result.points.every((p) => p.availableAtUtc === w.seriesAvailableAtUtc))
  assert.equal(result.acquiredAtUtc, native.acquiredAtUtc)
  assert.deepEqual(
    result.points.map((p) => p.acquiredAtUtc),
    native.points.map((p) => p.acquiredAtUtc),
  )
  assert.equal(JSON.stringify(w.batches), before)
})
test('actual final series barrier must meet the same overall120s deadline', () => {
  const w = fixture()
  w.seriesAvailableAtUtc = iso(BASE + 120000)
  assert.ok(replay(w, ctx))
  w.seriesAvailableAtUtc = iso(BASE + 120001)
  assert.equal(replay(w, ctx), null)
})
test('final series barrier accessor cannot run or replace a native clock', () => {
  const w = fixture()
  let calls = 0
  Object.defineProperty(w, 'seriesAvailableAtUtc', {
    enumerable: true,
    get() {
      calls++
      return iso(BASE + 108600)
    },
  })
  assert.equal(replay(w, ctx), null)
  assert.equal(calls, 0)
})
