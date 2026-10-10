import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  ABI,
  HOSTS,
  POLICY,
  SUBJECT,
  prepareMorphoV2AdapterPlan,
  captureMorphoV2AdapterMetadata,
  replayMorphoV2AdapterMetadata,
  writeMorphoV2AdapterCapture,
} from './morpho-v2-liquidity-adapter-capture.mjs'
const plan = prepareMorphoV2AdapterPlan(),
  A = '0x1111111111111111111111111111111111111111',
  IMPL = '0x2222222222222222222222222222222222222222',
  ZERO = '0x' + '0'.repeat(40),
  sha = (v) => createHash('sha256').update(v).digest('hex'),
  seal = (v) => {
    const { sha256, ...body } = v
    return { ...body, sha256: sha(JSON.stringify(body)) }
  },
  origins = () => HOSTS.map((host) => ({ host, url: 'https://' + host + '/fixture-secret' }))
const current = {
  chainId: 1,
  blockNumber: '26150000',
  blockHash: '0x' + 'a'.repeat(64),
  blockTime: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
}
const rawHeader = (s) => ({
  number: '0x' + BigInt(s.blockNumber).toString(16),
  hash: s.blockHash,
  timestamp: '0x' + BigInt(Date.parse(s.blockTime) / 1000).toString(16),
})
function fixture({ adapter = A, clone = false, onFetch, mutateResult } = {}) {
  let starts = 0
  const urls = []
  const fetcher = async (url, options) => {
    starts++
    urls.push(url)
    onFetch?.(starts)
    assert.equal(options.redirect, 'error')
    const p = JSON.parse(options.body)
    let result
    if (p.method === 'eth_chainId') result = '0x1'
    else if (p.method === 'eth_getBlockByNumber') {
      const source =
        p.params[0] === 'finalized'
          ? current
          : [...plan.anchors.slice(0, 2).map((a) => a.source), current].find(
              (s) => BigInt(s.blockNumber) === BigInt(p.params[0]),
            )
      result = rawHeader(source)
    } else if (p.method === 'eth_getCode') {
      result =
        clone && p.params[0] === SUBJECT.destination
          ? '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3'
          : '0x60006000'
    } else {
      assert.equal(p.method, 'eth_call')
      const d = decodeFunctionData({ abi: ABI, data: p.params[0].data })
      result = encodeFunctionResult({
        abi: ABI,
        functionName: d.functionName,
        result:
          d.functionName === 'asset'
            ? SUBJECT.asset
            : d.functionName === 'decimals'
              ? p.params[0].to === SUBJECT.asset
                ? 6
                : 18
              : d.functionName === 'balanceOf'
                ? 0n
                : d.functionName === 'liquidityAdapter'
                  ? adapter
                  : d.functionName === 'liquidityData'
                    ? '0x1234'
                    : true,
      })
    }
    result = mutateResult?.(p, url, result) ?? result
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: p.id, result }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetcher, urls, count: () => starts }
}
let baseline
async function base() {
  if (!baseline) {
    const f = fixture()
    baseline = await captureMorphoV2AdapterMetadata(plan, origins(), { fetcher: f.fetcher })
    assert.equal(f.count(), 76)
  }
  return structuredClone(baseline)
}
test('fixed sealed historical own native headers and three-anchor no-RPC plan', () => {
  assert.equal(plan.subject.destination, SUBJECT.destination)
  assert.deepEqual(
    plan.anchors.slice(0, 2).map((x) => x.source.blockNumber),
    ['26100913', '26108081'],
  )
  assert.equal(POLICY.maxRequests, 94)
  assert.equal(POLICY.deadlineMs, 60000)
})
test('two-origin configured adapter metadata preserves raw code/data without claiming total pullability', async () => {
  const r = await base(),
    out = replayMorphoV2AdapterMetadata(r, plan)
  assert.equal(r.physicalStarts, 76)
  assert.deepEqual(out.history.elapsedSeconds, [0, 86400])
  for (const p of [...out.history.points, out.current]) {
    assert.equal(p.status, 'two_origin_configured_adapter_metadata')
    assert.equal(p.facts.liquidityAdapter, A)
    assert.equal(p.facts.adapterEnrolled, true)
    assert.equal(p.facts.liquidityData, '0x1234')
    assert.equal(p.facts.idleCashRaw, '0')
    assert.equal(p.facts.configuredAdapterPullableRaw, null)
    assert.equal(p.totalExitCapacity, null)
    assert.equal(p.holderEntitlement, null)
    assert.equal(p.facts.runtimeIdentities.vault.proxyInspection, 'unknown_direct_or_custom')
  }
  assert.equal(out.holderExecutableExit, false)
  assert.equal(out.forecastValidated, false)
  assert.equal(JSON.stringify(r).includes('fixture-secret'), false)
})
test('zero configured adapter is genuine absence and avoids adapter reads', async () => {
  const f = fixture({ adapter: ZERO }),
    r = await captureMorphoV2AdapterMetadata(plan, origins(), { fetcher: f.fetcher })
  assert.equal(r.physicalStarts, 64)
  const x = replayMorphoV2AdapterMetadata(r, plan)
  assert.equal(x.current.facts.adapterState, 'absent')
  assert.equal(x.current.facts.adapterEnrolled, null)
  assert.equal(x.current.facts.liquidityAdapter, ZERO)
  assert.equal(x.current.totalExitCapacity, null)
})
test('origins are snapshotted before await and exact minimal clone implementation is preserved', async () => {
  const os = origins(),
    f = fixture({
      clone: true,
      onFetch: (n) => {
        if (n === 1) {
          os[0].url = 'https://unapproved.example/key'
          os[0].host = 'unapproved.example'
          os.reverse()
          os.splice(0, 2)
        }
      },
    })
  const r = await captureMorphoV2AdapterMetadata(plan, os, { fetcher: f.fetcher })
  assert.equal(r.physicalStarts, 82)
  assert.equal(
    f.urls.some((u) => new URL(u).hostname === 'unapproved.example'),
    false,
  )
  const x = replayMorphoV2AdapterMetadata(r, plan)
  assert.equal(x.current.facts.runtimeIdentities.vault.implementationAddress, IMPL)
  assert.equal(x.current.facts.runtimeIdentities.vault.proxyInspection, 'exact_eip1167_runtime')
  assert.equal(JSON.stringify(r).includes('fixture-secret'), false)
})
test('wrong native identity and code disagreement clear all derived facts', async () => {
  const b = await base()
  for (const mutate of [
    (r) => {
      const t = r.traces.find((t) => t.key === 'asset')
      t.response.result = encodeFunctionResult({ abi: ABI, functionName: 'asset', result: A })
    },
    (r) => {
      r.traces.find((t) => t.key === 'code_adapter').response.result = '0x6001'
    },
  ]) {
    const r = structuredClone(b)
    mutate(r)
    const x = replayMorphoV2AdapterMetadata(seal(r), plan)
    assert.equal(x.history.points[0].facts, null)
    assert.equal(x.history.points[0].totalExitCapacity, null)
  }
})
test('exact EIP1898 calldata, headers, clocks, budget and primitive values cannot be forged', async () => {
  for (const mutate of [
    (r) => (r.traces.find((t) => t.key === 'idleCash').request.params[1].requireCanonical = false),
    (r) => (r.traces.find((t) => t.key === 'liquidityData').request.params[0].data = '0x'),
    (r) =>
      (r.traces[4].completedAt = new Date(Date.parse(r.traces[4].startedAt) + 8251).toISOString()),
    (r) => (r.physicalStarts = 95),
    (r) => (r.traces.find((t) => t.key === 'code_vault').response.result = ['0x6000']),
    (r) => (r.traces.find((t) => t.key === 'header_before').request.params[0] = 'latest'),
    (r) =>
      (r.traces.find((t) => t.key === 'finalized').response.result.hash = '0x' + 'b'.repeat(64)),
  ]) {
    const r = await base()
    mutate(r)
    assert.throws(() => replayMorphoV2AdapterMetadata(seal(r), plan), /morpho_v2_capture/)
  }
})
test('unsettled aborted work closes capture before additional starts', async () => {
  let calls = 0
  const r = await captureMorphoV2AdapterMetadata(plan, origins(), {
    rpcTimeoutMs: 1,
    fetcher: async () => {
      calls++
      return new Promise(() => {})
    },
  })
  assert.equal(calls, 2)
  assert.equal(r.physicalStarts, 2)
  assert.equal(r.captureClosedReason, 'rpc_abort_unsettled')
  assert.equal(replayMorphoV2AdapterMetadata(r, plan).current.facts, null)
  for (const mutate of [
    (x) => (x.captureClosedReason = null),
    (x) => (x.traces[0].workSettled = 'false'),
    (x) => (x.traces[0].transport = ['timeout']),
    (x) => (x.traces[1].startedAt = x.traces[0].completedAt),
  ]) {
    const bad = structuredClone(r)
    mutate(bad)
    assert.throws(() => replayMorphoV2AdapterMetadata(seal(bad), plan), /morpho_v2_capture/)
  }
})
test('unsettled first-anchor work cannot be resealed with subsequent physical starts', async () => {
  const r = await base(),
    stopped = r.traces.find((t) => t.anchor === 0 && t.key === 'idleCash')
  stopped.response = null
  stopped.transport = 'timeout'
  stopped.workSettled = false
  assert(r.traces.some((t) => Date.parse(t.startedAt) >= Date.parse(stopped.completedAt)))
  assert.throws(() => replayMorphoV2AdapterMetadata(seal(r), plan), /unsettled_abort_reason/)
  r.captureClosedReason = 'rpc_abort_unsettled'
  assert.throws(() => replayMorphoV2AdapterMetadata(seal(r), plan), /start_after_unsettled_abort/)
})
test('foreign redirect and oversized streamed response do not become public proofs', async () => {
  for (const kind of ['redirect', 'oversize']) {
    const f = fixture(),
      fetcher = async (...args) => {
        if (kind === 'redirect')
          return {
            ok: true,
            redirected: true,
            url: 'https://foreign.example',
            body: new Response('{}').body,
          }
        return new Response('x'.repeat(131073))
      }
    const r = await captureMorphoV2AdapterMetadata(plan, origins(), { fetcher })
    const x = replayMorphoV2AdapterMetadata(r, plan)
    assert.equal(x.current.facts, null)
    assert(r.traces.every((t) => t.response === null))
  }
})
test('append-only writer preserves reserve after bytes and rejects URLs/no overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-adapter-'))
  try {
    const p = join(dir, 'capture.json'),
      r = await base(),
      ample = () => ({ bavail: POLICY.reserveBytes + POLICY.maxArtifactBytes, bsize: 1 })
    writeMorphoV2AdapterCapture(p, r, { statfs: ample })
    assert.equal(JSON.parse(readFileSync(p)).sha256, r.sha256)
    assert.throws(() => writeMorphoV2AdapterCapture(p, r, { statfs: ample }), /EEXIST/)
    assert.throws(
      () =>
        writeMorphoV2AdapterCapture(join(dir, 'low.json'), r, {
          statfs: () => ({ bavail: POLICY.reserveBytes, bsize: 1 }),
        }),
      /disk_reserve/,
    )
    assert.throws(
      () =>
        writeMorphoV2AdapterCapture(
          join(dir, 'url.json'),
          { diagnostic: 'https://provider/key' },
          { statfs: ample },
        ),
      /artifact_url/,
    )
    symlinkSync(p, join(dir, 'link'))
    assert.throws(
      () => writeMorphoV2AdapterCapture(join(dir, 'link'), r, { statfs: ample }),
      /EEXIST/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
