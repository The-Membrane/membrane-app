// Foreground paired historical stocks; never holder rights, queue totals or gross flows.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { encodeFunctionData, parseAbi } from 'viem'
// Exact identity shared with susde-public-initiation-common.mjs; no holder ABI here.
export const ROUTE = Object.freeze({
  vault: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  silo: '0x7fc7c91d556b400afa565013e3f32055a0713425',
})
export const STUDY = 'susde_joint_native_history_v1'
export const QUALIFIED_HISTORY_SHA256 =
  '3c0114ed0efed78c27a77d0e0cdd7d1d931fe15a8c5434ae7d4ca45881fc994f'
export const VAULT_CODE_SHA256 = '4ef7631314ff56c84fc45b5bbff1d2ee56a6ce1746d9f494bad8939822ecb0e7'
export const SOURCE_FILE_SHA256 = '62c2d60fdb2faa9b04bba1505092a98420dabd0b9f75276fe3ba5de16f26fb9b'
export const SOURCE_BODY_SHA256 = 'e2955484a88a9b7cb4edc171f4f94c52bb7df35f4c0528daa70acbc67977f3dd'
export const ASSET_CODE_SHA256 = 'e496966ae06cccbbab0d5b90f79b52d954778b10ecc8ea2a16f287ce602c06a6'
export const SILO_CODE_SHA256 = 'cbcdcfde9e967fb283d69d4978cf091cf09f632bd1247c858578e69632d7b9fe'
export const ASSET_SOURCE_FILE = 'data/research/venue-signals/susde-source-authority-v1/usde.json'
export const SILO_SOURCE_FILE = 'data/research/venue-signals/susde-source-authority-v1/silo.json'
export const ASSET_SOURCE_FILE_SHA256 =
  'b36d6ff0d97f1a798b8cf047181765497e2680c6e085efa7012ca5ea52b7f0ad'
export const SILO_SOURCE_FILE_SHA256 =
  'dfb558ea5623027295501a9857ccc0e22d871effaf3a9be54742778dbfdfcb14'
export const MAX_ANCHORS = 4
export const CALLS_PER_ORIGIN_ANCHOR = 11
export const SOURCE_FILE =
  'scripts/route-cohort/.cache/susde-source-26074702/source-62c2d60fdb2faa9b04bba1505092a98420dabd0b9f75276fe3ba5de16f26fb9b.json'
const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function cooldownDuration() view returns (uint24)',
])
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const INTERPRETATION = 'paired_correlated_net_stocks_not_gross_competing_flow_holder_E_or_queue_Q'
const exactKeys = (value, keys) => value && same(Object.keys(value).sort(), keys.sort())
const DEC = /^(0|[1-9][0-9]*)$/
const hex = (n) => `0x${BigInt(n).toString(16)}`
export const sha256 = (x) => createHash('sha256').update(x).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const assert = (ok, why) => {
  if (!ok) throw Error(`susde_joint_${why}`)
}
const seal = (body) => ({ ...body, sha256: sha256(JSON.stringify(body)) })
function unseal(value) {
  const { sha256: hash, ...body } = value
  assert(hash === sha256(JSON.stringify(body)), 'seal')
  return body
}
function clock(x) {
  const t = Date.parse(x)
  assert(Number.isFinite(t) && new Date(t).toISOString() === x, 'clock')
  return t
}
function boundedFile(file, max = 4 * 1024 * 1024) {
  assert(statSync(file).size <= max, 'file_budget')
  return readFileSync(file)
}
// Reconstruct every declared immutable substitution rather than trusting a match label.
export function verifyNativeSource(body, kind) {
  assert(kind === 'asset' || kind === 'silo', 'native_kind')
  assert(
    body.address?.toLowerCase() === ROUTE[kind] &&
      body.chainId === '1' &&
      body.runtimeMatch === 'exact_match' &&
      body.creationMatch === (kind === 'asset' ? 'exact_match' : null),
    'native_source_identity',
  )
  const runtime = body.runtimeBytecode
  assert(
    runtime &&
      /^0x(?:[0-9a-f]{2})+$/.test(runtime.recompiledBytecode) &&
      /^0x(?:[0-9a-f]{2})+$/.test(runtime.onchainBytecode),
    'native_runtime_shape',
  )
  assert(exactKeys(runtime.linkReferences, []), 'native_link_references')
  const references = runtime.immutableReferences,
    values = runtime.transformationValues?.immutables
  const replacements = Object.entries(references ?? {}).flatMap(([id, entries]) =>
    entries.map(({ start, length }) => ({
      id,
      type: 'replace',
      offset: start,
      reason: 'immutable',
      length,
    })),
  )
  assert(
    replacements.length > 0 &&
      same(
        runtime.transformations,
        replacements.map(({ length, ...t }) => t),
      ) &&
      exactKeys(values, Object.keys(references)) &&
      exactKeys(runtime.transformationValues, ['immutables']),
    'native_transformations',
  )
  const reconstructed = Buffer.from(runtime.recompiledBytecode.slice(2), 'hex'),
    occupied = new Set()
  for (const { id, offset, length } of replacements) {
    assert(
      Number.isInteger(offset) &&
        offset >= 0 &&
        length === 32 &&
        offset + length <= reconstructed.length &&
        WORD.test(values[id]),
      'native_immutable_shape',
    )
    for (let i = offset; i < offset + length; i++) {
      assert(!occupied.has(i) && reconstructed[i] === 0, 'native_immutable_overlap')
      occupied.add(i)
    }
    Buffer.from(values[id].slice(2), 'hex').copy(reconstructed, offset)
  }
  if (kind === 'silo') {
    assert(
      same(references, { 8: [{ start: 93, length: 32 }], 11: [{ start: 256, length: 32 }] }),
      'silo_immutable_locations',
    )
    const padded = (address) => `0x${address.slice(2).padStart(64, '0')}`
    assert(
      values['8'] === padded(ROUTE.vault) && values['11'] === padded(ROUTE.asset),
      'silo_immutable_address_binding',
    )
    const source = body.sources?.['contracts/USDeSilo.sol']?.content
    assert(
      source?.includes('msg.sender != _STAKING_VAULT') &&
        source.includes('external onlyStakingVault') &&
        source.includes('_USDE.transfer(to, amount)'),
      'silo_source_semantics',
    )
  } else {
    assert(
      body.sources?.['contracts/USDe.sol']?.content?.includes('contract USDe') &&
        body.sources?.[
          'lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol'
        ]?.content?.includes('function balanceOf(address account)'),
      'asset_source_semantics',
    )
  }
  assert(
    `0x${reconstructed.toString('hex')}` === runtime.onchainBytecode,
    'native_runtime_reconstruction',
  )
  const runtimeSha256 = sha256(reconstructed)
  assert(
    runtimeSha256 === (kind === 'asset' ? ASSET_CODE_SHA256 : SILO_CODE_SHA256),
    'native_runtime_pin',
  )
  return {
    runtimeSha256,
    immutableBindings: kind === 'silo' ? { stakingVault: ROUTE.vault, usde: ROUTE.asset } : null,
  }
}
function pinNativeSource(file, kind, expectedHash) {
  const bytes = boundedFile(file)
  assert(sha256(bytes) === expectedHash, 'native_literal_file_pin')
  const proof = verifyNativeSource(JSON.parse(bytes), kind)
  return { file, fileSha256: expectedHash, ...proof }
}
export function pinSource(
  file = SOURCE_FILE,
  nativeFiles = { asset: ASSET_SOURCE_FILE, silo: SILO_SOURCE_FILE },
) {
  const bytes = boundedFile(file),
    saved = JSON.parse(bytes),
    raw = saved.responseRaw
  assert(
    sha256(bytes) === SOURCE_FILE_SHA256 && sha256(raw) === SOURCE_BODY_SHA256,
    'literal_source_pin',
  )
  assert(
    typeof raw === 'string' &&
      sha256(raw) === saved.responseSha256 &&
      saved.address === ROUTE.vault,
    'source_pin',
  )
  const body = JSON.parse(raw)
  assert(
    body.address?.toLowerCase() === ROUTE.vault && body.chainId === '1' && body.runtimeMatch,
    'source_identity',
  )
  const source = body.sources?.['contracts/StakedUSDeV2.sol']?.content
  const silo = body.sources?.['contracts/USDeSilo.sol']?.content
  assert(
    source?.includes('_withdraw(msg.sender, address(silo), msg.sender, assets, shares)') &&
      source.includes('silo.withdraw(receiver, assets)') &&
      silo?.includes('_USDE.transfer(to, amount)'),
    'source_semantics',
  )
  assert(
    sha256(Buffer.from(body.runtimeBytecode.onchainBytecode.slice(2), 'hex')) === VAULT_CODE_SHA256,
    'source_runtime_pin',
  )
  return {
    file,
    fileSha256: sha256(bytes),
    bodySha256: sha256(raw),
    sourceUrl: saved.sourceUrl,
    attestation: saved.attestation,
    asset: pinNativeSource(nativeFiles.asset, 'asset', ASSET_SOURCE_FILE_SHA256),
    silo: pinNativeSource(nativeFiles.silo, 'silo', SILO_SOURCE_FILE_SHA256),
    semantics: 'cooldown_moves_vault_assets_to_silo_unstake_pays_silo_assets',
  }
}

// Existing receipts contain sealed rows, not raw RPC traces. Re-read both stocks
// during execution; no old receipt is represented as independently RPC-replayed.
export async function qualifySavedHistory({
  auditFile = 'data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json',
  root = 'data/research/venue-signals/local-carry-cash-v1',
} = {}) {
  const auditBytes = boundedFile(auditFile),
    audit = JSON.parse(auditBytes)
  unseal(audit)
  const history = Object.values(audit.histories).find(
    (h) => h.identity.destination === ROUTE.vault && h.identity.asset === ROUTE.asset,
  )
  assert(history?.points.length === 120, 'history_dimensions')
  const { buildSubjectManifest } = await import('../record-carry-cash-issues.mjs')
  const { verifyLocalCarryCash } = await import('../lib/localCarryCashStore.mjs')
  const manifest = await buildSubjectManifest()
  const verified = verifyLocalCarryCash(manifest, root, {
    maxRecords: 512,
    maxTotalBytes: 64 * 1024 * 1024,
  })
  assert(manifest.sha256 === history.witness.manifestSha256, 'manifest_pin')
  const prefix = audit.profile.lanes.find((x) => x.name === 'core')
  assert(
    prefix &&
      verified.records.length >= prefix.prefixCount &&
      verified.records[prefix.prefixCount - 1].sha256 === prefix.prefixHeadSha256 &&
      prefix.manifestSha256 === manifest.sha256,
    'frozen_prefix_pin',
  )
  clock(history.witness.availableAt)
  const anchors = history.points.map(([index, blockNumber, blockHash, sourceAt, vaultUsdeRaw]) => {
    const matches = verified.records.filter(
      (r) =>
        r.collectionMode === 'retrospective' &&
        r.block === blockNumber &&
        r.blockHash === blockHash &&
        r.blockAt === sourceAt,
    )
    assert(matches.length === 1, 'saved_receipt_missing')
    const r = matches[0],
      row = r.rows.find((x) => x.destination === ROUTE.vault && x.asset === ROUTE.asset)
    assert(
      row?.state === 'observed' && row.cashRaw === vaultUsdeRaw && row.assetDecimals === 18,
      'saved_cash_mismatch',
    )
    return {
      index,
      blockNumber,
      blockHash,
      sourceAt,
      vaultUsdeRaw,
      anchorAt: r.anchorAt,
      oldReadAt: r.firstLocalReceiptAt,
      oldAvailableAt: history.witness.availableAt,
      receiptSha256: r.sha256,
    }
  })
  assert(anchors.at(-1).receiptSha256 === history.witness.lastDailyReceiptSha256, 'last_daily_pin')
  return seal({
    study: STUDY,
    auditFile,
    auditFileSha256: sha256(auditBytes),
    auditBodySha256: audit.sha256,
    manifestSha256: manifest.sha256,
    qualification: 'sealed_receipts_only_requires_new_paired_raw_rpc_replay',
    anchors,
  })
}

function validateOrigins(origins) {
  assert(
    Array.isArray(origins) &&
      origins.length === 2 &&
      origins.every((x) => typeof x === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(x)) &&
      new URL(origins[0]).hostname !== new URL(origins[1]).hostname,
    'independent_origins',
  )
}
function validatePlan(plan) {
  unseal(plan)
  assert(
    exactKeys(plan, [
      'study',
      'qualifiedHistory',
      'sourcePin',
      'indices',
      'origins',
      'anchors',
      'rpcCallBudget',
      'interpretation',
      'sha256',
    ]) && plan.interpretation === INTERPRETATION,
    'plan_shape',
  )
  assert(
    plan.study === STUDY && plan.qualifiedHistory?.sha256 === QUALIFIED_HISTORY_SHA256,
    'qualification_pin',
  )
  unseal(plan.qualifiedHistory)
  validateOrigins(plan.origins)
  const indices = plan.indices
  assert(
    Array.isArray(indices) &&
      indices.length >= 2 &&
      indices.length <= MAX_ANCHORS &&
      indices.every(
        (x, i) => Number.isInteger(x) && x >= 0 && x < 120 && (i === 0 || x === indices[i - 1] + 1),
      ),
    'contiguous_pilot',
  )
  assert(
    same(
      plan.anchors,
      indices.map((i) => plan.qualifiedHistory.anchors[i]),
    ) && plan.rpcCallBudget === 22 * indices.length,
    'plan_binding',
  )
  assert(same(plan.sourcePin, pinSource()), 'literal_source_pin')
  return plan
}
export function createPlan({ qualifiedHistory, indices = [116, 117, 118, 119], origins }) {
  const plan = seal({
    study: STUDY,
    qualifiedHistory,
    sourcePin: pinSource(),
    indices,
    origins,
    anchors: indices.map((i) => qualifiedHistory.anchors[i]),
    rpcCallBudget: 22 * indices.length,
    interpretation: INTERPRETATION,
  })
  validatePlan(plan)
  return plan
}
export function requestsFor(anchor) {
  const pin = { blockHash: anchor.blockHash, requireCanonical: true }
  const call = (to, functionName, args = []) => ({
    method: 'eth_call',
    params: [{ to, data: encodeFunctionData({ abi: ABI, functionName, args }) }, pin],
  })
  const header = { method: 'eth_getBlockByNumber', params: [hex(anchor.blockNumber), false] }
  return [
    { method: 'eth_chainId', params: [] },
    header,
    ...['vault', 'asset', 'silo'].map((k) => ({ method: 'eth_getCode', params: [ROUTE[k], pin] })),
    call(ROUTE.vault, 'asset'),
    call(ROUTE.vault, 'silo'),
    call(ROUTE.vault, 'cooldownDuration'),
    call(ROUTE.asset, 'balanceOf', [ROUTE.vault]),
    call(ROUTE.asset, 'balanceOf', [ROUTE.silo]),
    header,
  ]
}
function derive(anchor, trace) {
  const req = requestsFor(anchor)
  assert(Array.isArray(trace) && trace.length === req.length, 'trace_count')
  let last = -Infinity
  const results = trace.map((t, i) => {
    assert(same(t.request, req[i]), 'trace_request')
    const start = clock(t.startedAt),
      end = clock(t.completedAt)
    assert(start >= last && end >= start, 'trace_clock')
    last = end
    assert(Object.hasOwn(t, 'result'), 'trace_result')
    return t.result
  })
  assert(
    clock(trace[0].startedAt) >= clock(anchor.oldAvailableAt) &&
      clock(anchor.oldReadAt) >= clock(anchor.sourceAt) &&
      clock(anchor.oldAvailableAt) >= clock(anchor.oldReadAt),
    'retrospective_clock',
  )
  assert(results[0] === '0x1', 'chain')
  const h = results[1],
    again = results.at(-1)
  for (const x of [h, again])
    assert(
      x?.hash === anchor.blockHash &&
        x.number === hex(anchor.blockNumber) &&
        /^0x[0-9a-f]+$/.test(x.timestamp) &&
        new Date(Number(BigInt(x.timestamp)) * 1000).toISOString() === anchor.sourceAt,
      'header',
    )
  assert(same(h, again), 'header_changed')
  for (const [i, k] of ['vault', 'asset', 'silo'].entries()) {
    const code = results[i + 2]
    assert(
      typeof code === 'string' &&
        /^0x(?:[0-9a-f]{2})+$/.test(code) &&
        code.length <= 262146 &&
        sha256(Buffer.from(code.slice(2), 'hex')) ===
          { vault: VAULT_CODE_SHA256, asset: ASSET_CODE_SHA256, silo: SILO_CODE_SHA256 }[k],
      'code_pin',
    )
  }
  const word = (x) => {
    assert(WORD.test(x), 'word')
    return BigInt(x)
  }
  const addr = (x) => {
    word(x)
    assert(x.slice(2, 26) === '0'.repeat(24), 'address_word')
    return `0x${x.slice(26)}`
  }
  assert(addr(results[5]) === ROUTE.asset && addr(results[6]) === ROUTE.silo, 'identity')
  const duration = word(results[7])
  assert(duration <= 90n * 86400n, 'duration')
  const vault = word(results[8]).toString(),
    silo = word(results[9]).toString()
  assert(vault === anchor.vaultUsdeRaw, 'old_cash_reread_mismatch')
  return {
    ...anchor,
    vaultUsdeRaw: vault,
    siloUsdeRaw: silo,
    cooldownDurationSeconds: duration.toString(),
    pairedReadStartedAt: trace[0].startedAt,
    pairedReadCompletedAt: trace.at(-1).completedAt,
  }
}
const trustedClients = new WeakSet()
const MAX_BODY_BYTES = 65536,
  MAX_TOTAL_BYTES = 8 * 1024 * 1024,
  RUN_MS = 120000
// URLs are held only in private closures. Public traces contain hostname origins.
// Native fetch receives a physical abort signal; there are no redirects or retries.
export function createBoundedClients({ urls, approvedOrigins, fetchImpl = globalThis.fetch }) {
  validateOrigins(approvedOrigins)
  assert(
    Array.isArray(urls) && urls.length === 2 && typeof fetchImpl === 'function',
    'client_inputs',
  )
  return Object.freeze(
    urls.map((url, i) => {
      const parsed = new URL(url)
      assert(
        parsed.protocol === 'https:' &&
          parsed.origin === approvedOrigins[i] &&
          !parsed.username &&
          !parsed.password,
        'client_origin',
      )
      let active = false
      const client = {
        origin: parsed.origin,
        async request(method, params, { timeoutMs = 12000 } = {}) {
          assert(!active && timeoutMs > 0 && timeoutMs <= 12000, 'client_budget')
          active = true
          const controller = new AbortController(),
            timer = setTimeout(() => controller.abort(), timeoutMs)
          let reader
          try {
            const response = await fetchImpl(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              redirect: 'error',
              signal: controller.signal,
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            })
            assert(response?.ok === true && response.redirected !== true, 'rpc_response')
            const declared = response.headers?.get?.('content-length')
            assert(
              declared === null ||
                declared === undefined ||
                (/^[0-9]+$/.test(declared) && Number(declared) <= MAX_BODY_BYTES),
              'body_budget',
            )
            assert(response.body?.getReader, 'stream_required')
            reader = response.body.getReader()
            const chunks = []
            let bytes = 0
            while (true) {
              const part = await reader.read()
              if (part.done) break
              bytes += part.value.byteLength
              assert(bytes <= MAX_BODY_BYTES, 'body_budget')
              chunks.push(Buffer.from(part.value))
            }
            const raw = Buffer.concat(chunks).toString('utf8'),
              body = JSON.parse(raw)
            assert(
              body.jsonrpc === '2.0' &&
                body.id === 1 &&
                Object.hasOwn(body, 'result') &&
                !Object.hasOwn(body, 'error'),
              'rpc_envelope',
            )
            return { rawBody: raw, result: body.result }
          } catch (error) {
            if (controller.signal.aborted) throw Error('susde_joint_rpc_timeout')
            throw Error(
              error?.message?.startsWith('susde_joint_')
                ? error.message
                : 'susde_joint_rpc_unavailable',
            )
          } finally {
            controller.abort()
            clearTimeout(timer)
            await reader?.cancel().catch(() => {})
            active = false
          }
        },
      }
      Object.freeze(client)
      trustedClients.add(client)
      return client
    }),
  )
}
export function replay(capture, { plan, captureFileSha256 } = {}) {
  validatePlan(plan)
  unseal(capture)
  assert(
    exactKeys(capture, ['study', 'planSha256', 'startedAt', 'hosts', 'availableAt', 'sha256']),
    'capture_shape',
  )
  assert(
    capture.study === STUDY && capture.planSha256 === plan.sha256 && capture.hosts?.length === 2,
    'capture_identity',
  )
  assert(Buffer.byteLength(JSON.stringify(capture)) <= MAX_TOTAL_BYTES * 2, 'capture_budget')
  const runStart = clock(capture.startedAt),
    runEnd = clock(capture.availableAt)
  assert(runEnd >= runStart && runEnd - runStart <= RUN_MS, 'run_clock')
  let last = runStart,
    totalBytes = 0,
    calls = 0
  const decoded = capture.hosts.map((h, j) => {
    assert(exactKeys(h, ['origin', 'traces']), 'host_shape')
    assert(h.origin === plan.origins[j] && h.traces?.length === plan.anchors.length, 'host')
    return h.traces.map((trace, i) => {
      for (const t of trace) {
        assert(
          exactKeys(t, ['request', 'result', 'rawBody', 'startedAt', 'completedAt']),
          'trace_shape',
        )
        const start = clock(t.startedAt),
          end = clock(t.completedAt)
        assert(
          start >= last && end >= start && end <= runEnd && end - start <= 12000,
          'global_clock',
        )
        last = end
        assert(
          typeof t.rawBody === 'string' && Buffer.byteLength(t.rawBody) <= MAX_BODY_BYTES,
          'body_budget',
        )
        totalBytes += Buffer.byteLength(t.rawBody)
        assert(totalBytes <= MAX_TOTAL_BYTES, 'aggregate_budget')
        const raw = JSON.parse(t.rawBody)
        assert(
          raw.jsonrpc === '2.0' &&
            raw.id === 1 &&
            !Object.hasOwn(raw, 'error') &&
            Object.hasOwn(raw, 'result') &&
            same(raw.result, t.result),
          'raw_body_binding',
        )
        calls++
      }
      return derive(plan.anchors[i], trace)
    })
  })
  assert(calls === plan.rpcCallBudget, 'call_budget')
  const rows = plan.anchors.map((a, i) => {
    const pair = decoded.map((h) => h[i])
    const stock = (x) => ({
      vaultUsdeRaw: x.vaultUsdeRaw,
      siloUsdeRaw: x.siloUsdeRaw,
      cooldownDurationSeconds: x.cooldownDurationSeconds,
    })
    assert(same(stock(pair[0]), stock(pair[1])), 'origin_disagreement')
    for (const k of [2, 3, 4])
      assert(
        capture.hosts[0].traces[i][k].result === capture.hosts[1].traces[i][k].result,
        'code_disagreement',
      )
    return {
      ...pair[0],
      pairedReadStartedAt: pair[0].pairedReadStartedAt,
      pairedReadCompletedAt: pair[1].pairedReadCompletedAt,
      availableAt: capture.availableAt,
    }
  })
  const changes = rows.slice(1).map((r, i) => ({
    fromIndex: rows[i].index,
    toIndex: r.index,
    vaultNetUsdeRaw: (BigInt(r.vaultUsdeRaw) - BigInt(rows[i].vaultUsdeRaw)).toString(),
    siloNetUsdeRaw: (BigInt(r.siloUsdeRaw) - BigInt(rows[i].siloUsdeRaw)).toString(),
    availableAt: capture.availableAt,
  }))
  const physicallyPinned = captureFileSha256 !== undefined
  if (physicallyPinned)
    assert(
      SHA.test(captureFileSha256) && captureFileSha256 === sha256(JSON.stringify(capture) + '\n'),
      'external_capture_pin',
    )
  return seal({
    study: STUDY,
    planSha256: plan.sha256,
    rows,
    changes,
    interpretation: plan.interpretation,
    captureAuthority: physicallyPinned
      ? 'external_file_bytes_pin_supplied'
      : 'consistency_only_self_seal_is_not_authentication',
    vaultAuthority: 'literal_verified_source_runtime_pin',
    assetAuthority: 'literal_verified_source_runtime_pin',
    siloAuthority: 'literal_verified_source_runtime_pin_and_vault_asset_immutable_bindings',
    forecastProjection: null,
    forecastEligibility: 'qualified_native_channel_observations_ready_for_model_not_a_forecast',
    holderE: 'not_measured',
    queueQ: 'not_measured',
    grossFlow: 'not_measured',
  })
}
export async function executePlan({ plan, clients, now = () => new Date().toISOString() }) {
  validatePlan(plan)
  assert(
    Array.isArray(clients) &&
      clients.length === 2 &&
      clients.every((c, i) => trustedClients.has(c) && c.origin === plan.origins[i]),
    'trusted_clients',
  )
  const startedAt = now(),
    start = clock(startedAt),
    monotonicStart = performance.now(),
    hosts = []
  let bytes = 0,
    calls = 0
  for (const client of clients) {
    const traces = []
    for (const anchor of plan.anchors) {
      const trace = []
      for (const request of requestsFor(anchor)) {
        const started = now(),
          remaining = Math.min(
            RUN_MS - (clock(started) - start),
            RUN_MS - (performance.now() - monotonicStart),
          )
        assert(++calls <= plan.rpcCallBudget && remaining > 0, 'run_budget')
        const { rawBody, result } = await client.request(request.method, request.params, {
          timeoutMs: Math.min(12000, remaining),
        })
        const completed = now()
        assert(
          clock(completed) >= clock(started) &&
            clock(completed) - start <= RUN_MS &&
            performance.now() - monotonicStart <= RUN_MS,
          'run_budget',
        )
        bytes += Buffer.byteLength(rawBody)
        assert(bytes <= MAX_TOTAL_BYTES, 'aggregate_budget')
        trace.push({ request, result, rawBody, startedAt: started, completedAt: completed })
      }
      derive(anchor, trace)
      traces.push(trace)
    }
    hosts.push({ origin: client.origin, traces })
  }
  const capture = seal({
    study: STUDY,
    planSha256: plan.sha256,
    startedAt,
    hosts,
    availableAt: now(),
  })
  return { capture, observation: replay(capture, { plan }) }
}
