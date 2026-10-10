// Root-only manual research extension. Importing creates no providers, timers or RPC.
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  statfsSync,
} from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { getHeapStatistics } from 'node:v8'
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  encodeFunctionResult,
  keccak256,
} from 'viem'
import {
  configuredUsd3HypotheticalOrigins,
  createUsd3HypotheticalCaptureControl,
  parseUsd3HypotheticalJson,
} from './usd3-hypothetical-history-capture.mjs'
import * as backtest from './fluid-bridge-usdc-historical-holder-backtest.mts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SELF = fileURLToPath(import.meta.url)
export const PLAN_PATH =
  'data/research/venue-signals/fluid-usdt-native-conversion-extension-v1.plan.json'
const PLAN_FILE_SHA256 = 'ece8ce9a96f0ebb59c32be688bb55bd683dd3fe5c70067a78ba4212f876996ab'
export const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
export const CONTRACTS = Object.freeze({
  bridge: '0x273da948aca9261043fbdb2a857bc255ecc29012',
  usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  pool: '0x3416cf6c708da44db2624d63ea0aaef7113527c6',
})
export const Q_RAW = '10145'
export const BATCH_SIZES = Object.freeze([3, 3, 2, 2])
const FILE = 8 * 1024 * 1024,
  COHORT = 32 * 1024 * 1024,
  TAIL = 512 * 1024,
  RESERVE = 256 * 1024 * 1024,
  MAX = (1n << 256n) - 1n
export const FLAGS = Object.freeze({
  originalAuthority: false,
  authenticated: false,
  executionQualified: false,
  forecastIssued: false,
  calibrated: false,
  coveragePromotion: false,
  historicalOwnership: false,
  minedPayout: false,
  sourceImplementationEquivalence: false,
  actualUserQuestion: false,
  MRaw: null,
})
export const ABI = parseAbi([
  'function getPool(address,address,uint24) view returns(address)',
  'function token0() view returns(address)',
  'function token1() view returns(address)',
  'function fee() view returns(uint24)',
  'function factory() view returns(address)',
  'function liquidity() view returns(uint128)',
  'function decimals() view returns(uint8)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
])
const sha = (v) => createHash('sha256').update(v).digest('hex')
const check = (ok, code) => {
  if (!ok) throw Error('fluid_usdt_extension_' + code)
}
const pick = (m, k) => m[k] ?? m.default?.[k]
export function snapshot(value) {
  let count = 0,
    bytes = 0
  const seen = new Set()
  const copy = (v, d) => {
    check(++count <= 200000 && d <= 24, 'plain_bound')
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isFinite(v), 'number')
      return v
    }
    if (typeof v === 'string') {
      bytes += v.length * 2
      check(bytes <= FILE, 'plain_bytes')
      return v
    }
    check(
      v && typeof v === 'object' && !seen.has(v) && Object.getOwnPropertySymbols(v).length === 0,
      'plain_value',
    )
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    let out
    if (Array.isArray(v)) {
      check(v.length <= 10000 && Object.keys(ds).length === v.length + 1, 'dense')
      out = Array.from({ length: v.length }, (_, i) => {
        const a = ds[String(i)]
        check(a && Object.hasOwn(a, 'value') && a.enumerable, 'accessor')
        return copy(a.value, d + 1)
      })
    } else {
      check(
        Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null,
        'prototype',
      )
      out = {}
      for (const [k, a] of Object.entries(ds)) {
        bytes += k.length * 2
        check(
          k.length <= 256 &&
            bytes <= FILE &&
            !['__proto__', 'constructor', 'prototype'].includes(k) &&
            a.enumerable &&
            Object.hasOwn(a, 'value'),
          'accessor',
        )
        out[k] = copy(a.value, d + 1)
      }
    }
    seen.delete(v)
    return out
  }
  return copy(value, 0)
}
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
      .join(',') +
    '}'
  )
}
const json = (v) => Buffer.from(JSON.stringify(snapshot(v)) + '\n') // Preserve the existing controller row field order when storing original receipts.
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const uint = (v) => {
  check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX, 'uint')
  return BigInt(v)
}
const time = (v) => {
  check(typeof v === 'string' && new Date(Date.parse(v)).toISOString() === v, 'utc')
  return Date.parse(v)
}
function safePath(path) {
  check(resolve(path) === path, 'path')
  let at = ''
  for (const p of path.slice(1).split('/')) {
    at += '/' + p
    check(!lstatSync(at).isSymbolicLink(), 'symlink')
  }
}
function read(path, privateFile = false) {
  safePath(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    check(
      s.isFile() && s.size <= FILE && (!privateFile || ((s.mode & 511) === 384 && s.nlink === 1)),
      'file',
    )
    const bytes = readFileSync(fd),
      after = fstatSync(fd)
    check(
      bytes.length === s.size &&
        after.ino === s.ino &&
        after.size === s.size &&
        after.mtimeMs === s.mtimeMs,
      'file_drift',
    )
    return bytes
  } finally {
    closeSync(fd)
  }
}
function sync(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function reserve(path, bytes = 0, pre = false) {
  const s = statfsSync(path)
  check(
    Number(s.bavail) * Number(s.bsize) >= (pre ? 288 * 1024 * 1024 : RESERVE) + bytes,
    'disk_reserve',
  )
}
export function containsSecret(bytes, tokens) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    forms = [text]
  try {
    JSON.parse(text)
  } catch {
    if (text.includes('\\')) return true
  }
  for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    try {
      const v = JSON.parse(m[0])
      if (typeof v === 'string') forms.push(v)
    } catch {}
  }
  for (let pass = 0; pass < 3; pass++) {
    const n = forms.length
    for (let i = 0; i < n; i++) {
      try {
        const v = decodeURIComponent(forms[i])
        if (v !== forms[i]) forms.push(v)
      } catch {}
    }
  }
  return forms.some((v) => tokens.some((t) => v.includes(t)))
}
function tokensFor(origins) {
  const out = new Set(),
    generic = new Set(['', 'v1', 'v2', 'v3', 'eth', 'ethereum', 'mainnet', 'rpc'])
  for (const o of origins) {
    const u = new URL(o.url)
    out.add(o.url)
    out.add(u.href)
    for (const p of u.pathname.split('/'))
      if (!generic.has(p.toLowerCase())) {
        out.add(p)
        try {
          out.add(decodeURIComponent(p))
        } catch {}
      }
    for (const [k, v] of u.searchParams) {
      if (k) out.add(k)
      if (v) out.add(v)
    }
    if (u.search) out.add(u.search)
  }
  return [...out].filter(Boolean)
}
export function writeCohortArtifact(state, name, bytes, io, terminal = false) {
  check(/^[a-zA-Z0-9_.-]+$/.test(name) && bytes.length <= FILE, 'artifact_name')
  check(
    terminal
      ? bytes.length <= TAIL && state.accounted + bytes.length <= COHORT
      : state.accounted + bytes.length + TAIL <= COHORT,
    'artifact_cap',
  )
  io.reserve(bytes.length + (terminal ? 0 : TAIL))
  const fd = io.open(name)
  state.accounted += bytes.length
  state.incomplete.push({ file: name, reservedBytes: bytes.length })
  try {
    const st = io.stat(fd)
    check(st.isFile() && st.nlink === 1 && (st.mode & 511) === 384 && st.size === 0, 'private')
    io.write(fd, bytes)
    io.flush(fd)
    io.sync()
    const after = io.stat(fd),
      named = io.namedStat(name)
    check(
      after.isFile() &&
        named.isFile() &&
        !named.isSymbolicLink() &&
        after.dev === st.dev &&
        after.ino === st.ino &&
        named.dev === after.dev &&
        named.ino === after.ino &&
        after.size === bytes.length &&
        named.size === bytes.length &&
        after.nlink === 1 &&
        named.nlink === 1 &&
        (after.mode & 511) === 384 &&
        (named.mode & 511) === 384 &&
        after.mtimeMs === named.mtimeMs &&
        after.ctimeMs === named.ctimeMs,
      'artifact_identity',
    )
  } finally {
    io.close(fd)
  }
  state.files.push({ file: name, bytes: bytes.length, sha256: sha(bytes) })
  state.incomplete.splice(
    state.incomplete.findIndex((r) => r.file === name),
    1,
  )
}
export function safeOriginalSnapshot(receiptInput, settlementInput, tokens) {
  const receipt = snapshot(receiptInput),
    settlements = snapshot(settlementInput)
  check(
    !containsSecret(json(receipt), tokens) && !containsSecret(json(settlements), tokens),
    'privacy',
  )
  for (const row of [...receipt.ledger, ...settlements.map((s) => s.observation)]) {
    check(row && typeof row === 'object', 'original_observation')
    if (row.rawBodyBase64 !== null) {
      check(typeof row.rawBodyBase64 === 'string', 'raw_base64')
      const bytes = Buffer.from(row.rawBodyBase64, 'base64')
      check(
        bytes.toString('base64') === row.rawBodyBase64 &&
          bytes.length <= 65536 &&
          bytes.length === row.bodyBytes &&
          sha(bytes) === row.bodySha256,
        'raw_seal',
      )
      check(!containsSecret(bytes, tokens), 'privacy')
    }
  }
  return { receipt, settlements }
}

export function nativeCapacityRaw(fullEaRaw, prongs, feeBps) {
  const E = uint(fullEaRaw),
    p = snapshot(prongs)
  const keys = [
    'bridgeFunding',
    'bankCash',
    'bankSupply',
    'bankWithdrawableUntilLimit',
    'bankResolverWithdrawable',
  ]
  check(Object.keys(p).sort().join(',') === keys.sort().join(','), 'prong_keys')
  check(feeBps === 5, 'fee')
  const gross = Object.values(p)
    .map(uint)
    .reduce((a, b) => (a < b ? a : b))
  const product = gross * 9995n
  check(product <= MAX, 'fee_overflow')
  const net = product / 10000n
  return (E < net ? E : net).toString()
}
function normalizedFrame(f) {
  check(
    f.owner === null &&
      f.historicalOwnership === false &&
      f.holderSharesRaw === '967573479322309282' &&
      f.shareDecimals === 18 &&
      f.asset === CONTRACTS.usdc &&
      f.assetDecimals === 6 &&
      f.paused === false &&
      f.withdrawalFeeBps === 5,
    'native_frame',
  )
  return {
    source: f.source,
    fullSharesRaw: f.holderSharesRaw,
    fullNetEaRaw: f.fullHolderNetUsdcRaw,
    nativeProngs: f.nativeProngs,
    feeBps: 5,
    clippedNetCapacityRaw: nativeCapacityRaw(f.fullHolderNetUsdcRaw, f.nativeProngs, 5),
    oldAcquiredAtUtc: f.acquiredAtUtc,
    oldAvailableAtUtc: f.availableAtUtc,
    runtimeCodeHashes: f.runtimeCodeHashes,
    owner: null,
    historicalOwnership: false,
  }
}
function legacySeal(value, expected) {
  const { sha256, ...body } = value
  check(sha256 === expected && sha(JSON.stringify(body)) === expected, 'input_body_pin')
}
function readPin(p) {
  const bytes = read(resolve(ROOT, p.path), p.private)
  check(bytes.length === p.bytes && sha(bytes) === p.fileSha256, 'file_pin')
  if (p.bodySha256 !== null)
    legacySeal(parseUsd3HypotheticalJson(bytes.toString('utf8')), p.bodySha256)
  return bytes
}
const prepared = new WeakSet()
export function prepareFluidUsdtNativeConversionExtensionPlan() {
  const bytes = read(resolve(ROOT, PLAN_PATH), true)
  check(sha(bytes) === PLAN_FILE_SHA256, 'plan_file_pin')
  const p = parseUsd3HypotheticalJson(bytes.toString('utf8')),
    { sha256, ...body } = p
  check(
    sha256 === sha(canonical(body)) &&
      p.schema === 'fluid_usdt_native_conversion_extension_plan_v1' &&
      p.physicalStarts === 368 &&
      p.researchQRaw === Q_RAW &&
      p.actualUserQuestion === false &&
      p.owner === null &&
      p.historicalOwnership === false &&
      p.MRaw === null,
    'plan',
  )
  check(
    p.anchors.length === 10 && canonical(p.batchSizes) === canonical(BATCH_SIZES),
    'plan_anchors',
  )
  p.inputs.forEach(readPin)
  p.sourcePins.forEach(readPin)
  const texts = p.capturePaths.map((path) =>
    readPin(p.inputs.find((x) => x.path === path)).toString('utf8'),
  )
  // The pinned file list is acquisition order; the backtest join requires source order.
  // Earlier Sept24–27 cohort first, then Sept28–Oct1; retained Oct2 endpoints append natively.
  const reconstructedAtUtc = new Date().toISOString(),
    capturePaths = [p.capturePaths[1], p.capturePaths[0]]
  const report = pick(backtest, 'buildFluidBridgeUsdcHistoricalHolderBacktest')(
    parseUsd3HypotheticalJson(texts[1]),
    reconstructedAtUtc,
    {
      root: ROOT,
      captureText: texts[1],
      additionalCapture: { receipt: parseUsd3HypotheticalJson(texts[0]), captureText: texts[0] },
    },
  )
  check(
    report.frames.length === 10 &&
      canonical(report.frames.map(normalizedFrame)) === canonical(p.anchors),
    'native_original_join',
  )
  const nativeOriginalReplay = {
    reconstructedAtUtc,
    completedAtUtc: new Date().toISOString(),
    capturePaths,
  }
  const plan = freeze(snapshot({ ...p, nativeOriginalReplay }))
  prepared.add(plan)
  return plan
}
function anchorOk(a) {
  check(
    a &&
      a.owner === null &&
      a.historicalOwnership === false &&
      a.fullSharesRaw === '967573479322309282' &&
      a.feeBps === 5,
    'anchor_subject',
  )
  const s = a.source
  check(
    s &&
      s.chainId === 1 &&
      /^[1-9][0-9]*$/.test(s.blockNumber) &&
      /^0x[0-9a-f]{64}$/.test(s.blockHash),
    'source',
  )
  time(s.blockTime)
  time(a.oldAcquiredAtUtc)
  time(a.oldAvailableAtUtc)
  check(
    a.clippedNetCapacityRaw === nativeCapacityRaw(a.fullNetEaRaw, a.nativeProngs, 5),
    'weak_prong',
  )
}
const pin = (s) => ({ blockHash: s.blockHash, requireCanonical: true })
export function fluidUsdtNativeConversionExtensionRequests(anchorInput) {
  const a = snapshot(anchorInput)
  anchorOk(a)
  const s = a.source,
    h = {
      method: 'eth_getBlockByNumber',
      params: ['0x' + BigInt(s.blockNumber).toString(16), false],
    }
  const call = (key, to, name, args = []) => ({
    key,
    name,
    request: {
      method: 'eth_call',
      params: [{ to, data: encodeFunctionData({ abi: ABI, functionName: name, args }) }, pin(s)],
    },
  })
  const input = (key, amount) =>
    call(key, CONTRACTS.quoter, 'quoteExactInputSingle', [
      {
        tokenIn: CONTRACTS.usdc,
        tokenOut: CONTRACTS.usdt,
        amountIn: uint(amount),
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    ])
  return freeze([
    { key: 'header_before', request: h },
    ...['factory', 'quoter', 'pool', 'usdc', 'usdt'].map((k) => ({
      key: 'code_' + k,
      request: { method: 'eth_getCode', params: [CONTRACTS[k], pin(s)] },
    })),
    call('factory_pool', CONTRACTS.factory, 'getPool', [CONTRACTS.usdc, CONTRACTS.usdt, 100]),
    call('token0', CONTRACTS.pool, 'token0'),
    call('token1', CONTRACTS.pool, 'token1'),
    call('pool_fee', CONTRACTS.pool, 'fee'),
    call('pool_factory', CONTRACTS.pool, 'factory'),
    call('usdc_decimals', CONTRACTS.usdc, 'decimals'),
    call('usdt_decimals', CONTRACTS.usdt, 'decimals'),
    call('pool_liquidity', CONTRACTS.pool, 'liquidity'),
    input('full_ea_usdt', a.fullNetEaRaw),
    input('clipped_capacity_usdt', a.clippedNetCapacityRaw),
    call('required_usdc_for_research_q', CONTRACTS.quoter, 'quoteExactOutputSingle', [
      {
        tokenIn: CONTRACTS.usdc,
        tokenOut: CONTRACTS.usdt,
        amount: uint(Q_RAW),
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    ]),
    { key: 'header_after', request: h },
  ])
}
function decode(spec, result) {
  check(typeof result === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(result), 'abi_hex')
  const value = decodeFunctionResult({ abi: ABI, functionName: spec.name, data: result })
  check(
    encodeFunctionResult({ abi: ABI, functionName: spec.name, result: value }) === result,
    'abi_canonical',
  )
  return value
}
function header(v, s) {
  check(v && typeof v === 'object', 'header')
  check(
    /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v.number) &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v.timestamp) &&
      BigInt(v.number).toString() === s.blockNumber &&
      v.hash === s.blockHash &&
      Number(BigInt(v.timestamp)) * 1000 === time(s.blockTime),
    'header',
  )
}
export function replayFluidUsdtNativeConversionExtensionPoint(
  anchorInput,
  wireInput,
  runtimePinsInput,
) {
  const a = snapshot(anchorInput),
    w = snapshot(wireInput),
    runtimePins = snapshot(runtimePinsInput)
  anchorOk(a)
  check(
    Array.isArray(w) &&
      w.length === 2 &&
      w.every((o, i) => o.host === HOSTS[i] && Array.isArray(o.traces) && o.traces.length === 18),
    'origins',
  )
  const specs = fluidUsdtNativeConversionExtensionRequests(a),
    outputs = []
  for (const o of w) {
    const values = {},
      codes = {},
      errors = {}
    let latest = -Infinity,
      prior = time(a.oldAvailableAtUtc)
    for (let n = 0; n < 18; n++) {
      const t = o.traces[n],
        spec = specs[n]
      check(t.key === spec.key && canonical(t.request) === canonical(spec.request), 'request_join')
      check(
        time(t.startedAtUtc) >= prior && time(t.completedAtUtc) >= time(t.startedAtUtc),
        'read_clock',
      )
      prior = time(t.completedAtUtc)
      latest = Math.max(latest, prior)
      check(
        /^[a-f0-9]{64}$/.test(t.requestBodySha256) && /^[a-f0-9]{64}$/.test(t.responseBodySha256),
        'trace_digest',
      )
      const e = t.envelope
      check(e && e.jsonrpc === '2.0' && Number.isSafeInteger(e.id) && e.id > 0, 'envelope')
      if (Object.hasOwn(e, 'error')) {
        check(
          ['full_ea_usdt', 'clipped_capacity_usdt', 'required_usdc_for_research_q'].includes(
            spec.key,
          ),
          'nonquote_error',
        )
        check(
          !Object.hasOwn(e, 'result') &&
            Number.isSafeInteger(e.error.code) &&
            e.error.message === 'native_error',
          'native_error',
        )
        errors[spec.key] = { code: e.error.code, data: e.error.data ?? null }
        values[spec.key] = null
        continue
      }
      check(Object.keys(e).sort().join(',') === 'id,jsonrpc,result', 'envelope_keys')
      if (spec.key.startsWith('header_')) {
        header(e.result, a.source)
        continue
      }
      if (spec.key.startsWith('code_')) {
        check(typeof e.result === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(e.result), 'runtime_code')
        const key = spec.key.slice(5),
          hash = keccak256(e.result)
        check(runtimePins[key] === null || hash === runtimePins[key], 'runtime_pin')
        codes[key] = { hash, bytes: e.result }
        continue
      }
      values[spec.key] = decode(spec, e.result)
    }
    check(
      values.factory_pool.toLowerCase() === CONTRACTS.pool &&
        values.token0.toLowerCase() === CONTRACTS.usdc &&
        values.token1.toLowerCase() === CONTRACTS.usdt &&
        values.pool_factory.toLowerCase() === CONTRACTS.factory &&
        values.pool_fee === 100 &&
        values.usdc_decimals === 6 &&
        values.usdt_decimals === 6,
      'pool_identity_units',
    )
    const quotes = Object.fromEntries(
      ['full_ea_usdt', 'clipped_capacity_usdt', 'required_usdc_for_research_q'].map((k) => [
        k,
        values[k] === null ? null : values[k][0].toString(),
      ]),
    )
    if (quotes.required_usdc_for_research_q !== null)
      check(uint(quotes.required_usdc_for_research_q) > 0n, 'required_input')
    outputs.push({
      codes,
      quotes,
      errors,
      acquiredAtUtc: new Date(latest).toISOString(),
      liquidityRaw: values.pool_liquidity.toString(),
    })
  }
  check(
    canonical(outputs[0].codes) === canonical(outputs[1].codes) &&
      canonical(outputs[0].quotes) === canonical(outputs[1].quotes) &&
      outputs[0].liquidityRaw === outputs[1].liquidityRaw,
    'cross_origin_drift',
  )
  for (const k of Object.keys(outputs[0].errors))
    check(Object.hasOwn(outputs[1].errors, k), 'quote_status_drift')
  check(
    Object.keys(outputs[0].errors).length === Object.keys(outputs[1].errors).length,
    'quote_status_drift',
  )
  for (const key of Object.keys(outputs[0].errors))
    check(outputs[0].errors[key].data === outputs[1].errors[key].data, 'quote_error_data_drift')
  const x = outputs[0],
    acquiredAtUtc = new Date(Math.max(...outputs.map((o) => time(o.acquiredAtUtc)))).toISOString()
  return freeze({
    source: a.source,
    oldBridgeAcquiredAtUtc: a.oldAcquiredAtUtc,
    oldBridgeAvailableAtUtc: a.oldAvailableAtUtc,
    acquiredAtUtc,
    fullSharesRaw: a.fullSharesRaw,
    shareDecimals: 18,
    fullNetUsdcEaRaw: a.fullNetEaRaw,
    nativeProngs: a.nativeProngs,
    clippedNetUsdcCapacityRaw: a.clippedNetCapacityRaw,
    withdrawalFeeBps: 5,
    inputAsset: CONTRACTS.usdc,
    inputDecimals: 6,
    outputAsset: CONTRACTS.usdt,
    outputDecimals: 6,
    fullEaQuotedUsdtRaw: x.quotes.full_ea_usdt,
    clippedCapacityQuotedUsdtRaw: x.quotes.clipped_capacity_usdt,
    hypotheticalResearchQUsdtRaw: Q_RAW,
    requiredNetUsdcForResearchQRaw: x.quotes.required_usdc_for_research_q,
    quoteErrorsByOrigin: outputs.map((o) => ({
      host: HOSTS[outputs.indexOf(o)],
      errors: o.errors,
    })),
    runtimeCodeHashes: Object.fromEntries(
      Object.entries(x.codes).map(([k, v]) => [CONTRACTS[k], v.hash]),
    ),
    poolLiquidityDiagnosticRaw: x.liquidityRaw,
    sourceClass: 'captured_identical_runtimes_only',
    status: Object.values(x.quotes).some((v) => v === null)
      ? 'censored_native_quote_error'
      : 'conditional_native_quotes',
    owner: null,
    ...FLAGS,
  })
}
export function verifyConversionPhysical(
  receiptInput,
  settlementInput,
  requestInput,
  expectedStarts,
  anchorInputs,
) {
  const receipt = snapshot(receiptInput),
    settlements = snapshot(settlementInput),
    requests = snapshot(requestInput),
    anchors = snapshot(anchorInputs)
  check(
    Array.isArray(anchors) &&
      [2, 3].includes(anchors.length) &&
      expectedStarts === 2 + anchors.length * 36,
    'batch_anchors',
  )
  const expected = new Map(
      anchors.map((a) => [
        'anchor_' + a.source.blockNumber,
        new Map(fluidUsdtNativeConversionExtensionRequests(a).map((s) => [s.key, s.request])),
      ]),
    ),
    roles = new Set()
  check(expected.size === anchors.length, 'batch_anchor_duplicate')
  check(
    [110, 74].includes(expectedStarts) &&
      receipt.physicalStarts === expectedStarts &&
      receipt.ledger.length === expectedStarts &&
      settlements.length === expectedStarts &&
      requests.length === expectedStarts &&
      receipt.pendingSettlements === 0 &&
      receipt.failure === null,
    'physical_count',
  )
  const commits = new Map(receipt.terminalCommitments.map((c) => [c.physicalId, c.rowSha256])),
    settled = new Map(settlements.map((c) => [c.physicalId, c])),
    sent = new Map(requests.map((c) => [c.id, c]))
  check(
    commits.size === expectedStarts &&
      settled.size === expectedStarts &&
      sent.size === expectedStarts &&
      new Set(receipt.ledger.map((r) => r.physicalId)).size === expectedStarts,
    'physical_duplicates',
  )
  const last = new Map()
  let previous = -Infinity
  for (const row of receipt.ledger) {
    check(
      row.physicalId >= 1 &&
        row.physicalId <= expectedStarts &&
        row.accepted === true &&
        row.status === 'success' &&
        row.httpStatus === 200 &&
        HOSTS.includes(row.host) &&
        row.startedElapsedMs >= previous &&
        row.startedElapsedMs >= (last.get(row.host) ?? -Infinity) + 250 &&
        row.completedElapsedMs >= row.startedElapsedMs,
      'physical_start',
    )
    last.set(row.host, row.startedElapsedMs)
    previous = row.startedElapsedMs
    // Preserve the existing controller's insertion-order row/settlement seal unchanged.
    check(commits.get(row.physicalId) === sha(JSON.stringify(row)), 'physical_row_seal')
    const settlement = settled.get(row.physicalId),
      { sha256, ...body } = settlement ?? {}
    check(
      sha256 === sha(JSON.stringify(body)) && canonical(settlement.observation) === canonical(row),
      'settlement_join',
    )
    const request = sent.get(row.request.id)
    check(request && request.host === row.host && request.stage === row.stage, 'physical_request')
    const role = row.host + ':' + row.stage + ':' + request.key
    check(!roles.has(role), 'physical_role_duplicate')
    roles.add(role)
    const wanted =
      row.stage === 'chain'
        ? { method: 'eth_chainId', params: [] }
        : expected.get(row.stage)?.get(request.key)
    const { id, jsonrpc, ...methodParams } = row.request
    check(
      wanted &&
        jsonrpc === '2.0' &&
        Number.isSafeInteger(id) &&
        id > 0 &&
        canonical(wanted) === canonical(methodParams) &&
        (row.stage !== 'chain' || request.key === 'chain'),
      'physical_plan',
    )
    const requestBytes = Buffer.from(request.requestBodyBase64, 'base64')
    check(
      requestBytes.toString('base64') === request.requestBodyBase64 &&
        sha(requestBytes) === request.requestBodySha256 &&
        canonical(parseUsd3HypotheticalJson(requestBytes.toString('utf8'))) ===
          canonical(row.request),
      'request_bytes',
    )
    const bytes = Buffer.from(row.rawBodyBase64, 'base64')
    check(
      bytes.toString('base64') === row.rawBodyBase64 &&
        bytes.length === row.bodyBytes &&
        bytes.length <= 65536 &&
        sha(bytes) === row.bodySha256,
      'response_bytes',
    )
    const envelope = parseUsd3HypotheticalJson(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    )
    check(envelope.id === row.request.id && envelope.jsonrpc === '2.0', 'response_id')
    if (row.request.method === 'eth_chainId') check(envelope.result === '0x1', 'chain')
  }
  return true
}
export function cohortRetentionAllowed(elapsedMs, starts, expired = false) {
  check(
    Number.isFinite(elapsedMs) &&
      elapsedMs >= 0 &&
      elapsedMs < 480000 &&
      Number.isSafeInteger(starts) &&
      starts >= 0 &&
      starts <= 368 &&
      !expired,
    'cohort_deadline_or_count',
  )
  return true
}
export function cohortDispatchAllowed(elapsedMs, starts) {
  check(
    Number.isFinite(elapsedMs) &&
      elapsedMs >= 0 &&
      elapsedMs < 480000 &&
      Number.isSafeInteger(starts) &&
      starts >= 0 &&
      starts < 368,
    'cohort_deadline_or_count',
  )
  return true
}
export async function captureFluidUsdtNativeConversionExtension() {
  check(getHeapStatistics().heap_size_limit <= 448 * 1024 * 1024, 'heap_limit')
  const nativeNow = Date.now,
    started = performance.now(),
    startedAtUtc = new Date(nativeNow()).toISOString()
  reserve(ROOT, 0, true)
  const plan = prepareFluidUsdtNativeConversionExtensionPlan(),
    planBytes = read(resolve(ROOT, PLAN_PATH), true)
  const producerBytes = read(SELF),
    producerSha256 = sha(producerBytes)
  const sourceRows = plan.sourcePins.map((p) => ({ ...p, original: readPin(p) }))
  const before = () => {
    cohortRetentionAllowed(performance.now() - started, actualStarts, cohortExpired)
    check(
      sha(read(SELF)) === producerSha256 &&
        sha(read(resolve(ROOT, PLAN_PATH), true)) === PLAN_FILE_SHA256,
      'producer_or_plan_drift',
    )
    plan.inputs.forEach(readPin)
    plan.sourcePins.forEach(readPin)
    cohortRetentionAllowed(performance.now() - started, actualStarts, cohortExpired)
  }
  safePath(resolve(ROOT, 'data/research/venue-signals'))
  const out = join(
    ROOT,
    'data/research/venue-signals',
    'fluid-usdt-native-conversion-extension-' +
      startedAtUtc.replaceAll(':', '-') +
      '-' +
      randomUUID(),
  )
  mkdirSync(out, { mode: 0o700 })
  check((lstatSync(out).mode & 511) === 448, 'directory_mode')
  sync(dirname(out))
  const state = { accounted: 0, files: [], incomplete: [] }
  const io = {
    reserve: (n) => reserve(out, n),
    open: (name) =>
      openSync(
        join(out, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ),
    stat: fstatSync,
    namedStat: (name) => lstatSync(join(out, name)),
    write: (fd, b) => writeFileSync(fd, b),
    flush: fsyncSync,
    close: closeSync,
    sync: () => sync(out),
  }
  const write = (name, bytes, terminal = false) =>
    writeCohortArtifact(state, name, bytes, io, terminal)
  const save = (name, value, terminal = false) => write(name, json(value), terminal)
  let actualStarts = 0,
    control = null,
    receipt = null,
    requests = [],
    tokens = [],
    phase = 'preflight',
    cohortExpired = false
  const points = [],
    batches = [],
    retainedResponses = new Map()
  const timer = setTimeout(
    () => {
      cohortExpired = true
      control?.stop('cohort_deadline')
    },
    Math.max(0, 480000 - (performance.now() - started)),
  )
  const retain = (batch) => {
    const original = safeOriginalSnapshot(receipt, control.settlementReceipts, tokens)
    for (const row of original.receipt.ledger)
      if (row.rawBodyBase64 !== null) {
        const bytes = Buffer.from(row.rawBodyBase64, 'base64'),
          name = 'batch-' + batch + '-response-' + row.physicalId + '.bin'
        if (retainedResponses.has(name))
          check(retainedResponses.get(name) === sha(bytes), 'response_drift')
        else {
          write(name, bytes)
          retainedResponses.set(name, sha(bytes))
        }
      }
    save('batch-' + batch + '-original-receipt.json', original.receipt)
    save('batch-' + batch + '-original-settlements.json', original.settlements)
    save('batch-' + batch + '-request-wires.json', requests)
    return original
  }
  try {
    write('prepared-plan.json', planBytes)
    write('executed-producer.mjs', producerBytes)
    for (let n = 0; n < sourceRows.length; n++)
      write('source-' + n + '-' + sourceRows[n].path.split('/').at(-1), sourceRows[n].original)
    save(
      'source-snapshot.json',
      sourceRows.map(({ original, ...r }) => r),
    )
    before()
    const origins = await configuredUsd3HypotheticalOrigins()
    before()
    check(
      origins.length === 2 && origins.every((o, i) => o.host === HOSTS[i]),
      'configured_origins',
    )
    tokens = tokensFor(origins)
    process.stdout.write(
      JSON.stringify({
        phase: 'capture_started',
        out,
        anchors: 10,
        maxPhysicalStarts: 368,
        ...FLAGS,
      }) + '\n',
    )
    let offset = 0,
      firstRuntime = null
    for (let batch = 0; batch < 4; batch++) {
      before()
      phase = 'batch_' + batch
      control = createUsd3HypotheticalCaptureControl(origins)
      receipt = null
      requests = []
      const anchors = plan.anchors.slice(offset, offset + BATCH_SIZES[batch])
      offset += BATCH_SIZES[batch]
      const wires = anchors.map((anchor) => ({
        anchor,
        origins: HOSTS.map((host) => ({ host, traces: [] })),
      }))
      let id = 0,
        failure = null
      const send = async (index, stage, spec) => {
        const request = { jsonrpc: '2.0', id: ++id, ...spec.request },
          requestBytes = Buffer.from(JSON.stringify(request))
        check(!containsSecret(requestBytes, tokens), 'privacy')
        write('batch-' + batch + '-request-' + id + '.bin', requestBytes)
        requests.push({
          id,
          host: HOSTS[index],
          stage,
          key: spec.key,
          requestBodyBase64: requestBytes.toString('base64'),
          requestBodySha256: sha(requestBytes),
        })
        cohortDispatchAllowed(performance.now() - started, actualStarts + id - 1)
        check(!cohortExpired, 'cohort_deadline')
        const response = await control.fetcher(origins[index].url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: requestBytes.toString('utf8'),
        })
        const bytes = Buffer.from(await response.arrayBuffer())
        check(!containsSecret(bytes, tokens), 'privacy')
        const physicalId = Number(response.headers.get('x-usd3-physical-id'))
        check(Number.isSafeInteger(physicalId) && physicalId > 0, 'physical_id')
        safeOriginalSnapshot({ ledger: [] }, control.settlementReceipts, tokens)
        const name = 'batch-' + batch + '-response-' + physicalId + '.bin'
        write(name, bytes)
        retainedResponses.set(name, sha(bytes))
        const envelope = parseUsd3HypotheticalJson(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        )
        check(
          envelope.jsonrpc === '2.0' &&
            envelope.id === request.id &&
            Object.keys(envelope).sort().join(',') ===
              (Object.hasOwn(envelope, 'error') ? 'error,id,jsonrpc' : 'id,jsonrpc,result'),
          'rpc_envelope',
        )
        return {
          key: spec.key,
          request: spec.request,
          envelope,
          physicalId,
          requestBodySha256: sha(requestBytes),
          responseBodySha256: sha(bytes),
        }
      }
      try {
        control.beginStage('chain')
        await Promise.all(
          HOSTS.map(async (_, i) => {
            const t = await send(i, 'chain', {
              key: 'chain',
              request: { method: 'eth_chainId', params: [] },
            })
            check(t.envelope.result === '0x1', 'chain')
          }),
        )
        for (const w of wires) {
          before()
          const stage = 'anchor_' + w.anchor.source.blockNumber
          control.beginStage(stage)
          await Promise.all(
            HOSTS.map(async (_, i) => {
              for (const spec of fluidUsdtNativeConversionExtensionRequests(w.anchor))
                w.origins[i].traces.push(await send(i, stage, spec))
            }),
          )
        }
      } catch {
        failure = 'native_capture_unqualified'
        control.stop(failure)
      } finally {
        receipt = await control.finish()
        actualStarts += receipt.physicalStarts
      }
      const original = retain(batch)
      check(!failure, 'native_capture_unqualified')
      verifyConversionPhysical(
        original.receipt,
        original.settlements,
        requests,
        2 + anchors.length * 36,
        anchors,
      )
      const byId = new Map(original.receipt.ledger.map((r) => [r.physicalId, r]))
      for (const w of wires) {
        for (const o of w.origins)
          for (const t of o.traces) {
            const r = byId.get(t.physicalId)
            const sent = requests.find((q) => q.id === r?.request.id)
            const { jsonrpc, id, ...physicalRequest } = r?.request ?? {}
            check(
              r &&
                sent &&
                r.host === o.host &&
                r.bodySha256 === t.responseBodySha256 &&
                sent.requestBodySha256 === t.requestBodySha256 &&
                id === t.envelope.id &&
                jsonrpc === '2.0' &&
                canonical(physicalRequest) === canonical(t.request),
              'trace_physical_join',
            )
            t.startedAtUtc = r.startedAtUtc
            t.completedAtUtc = r.completedAtUtc
            if (Object.hasOwn(t.envelope, 'error')) {
              const e = t.envelope.error
              check(Number.isSafeInteger(e.code), 'native_error_code')
              t.envelope = {
                jsonrpc: '2.0',
                id: t.envelope.id,
                error: {
                  code: e.code,
                  message: 'native_error',
                  ...(typeof e.data === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(e.data)
                    ? { data: e.data }
                    : {}),
                },
              }
            }
          }
        const point = replayFluidUsdtNativeConversionExtensionPoint(
          w.anchor,
          w.origins,
          plan.conversionRuntimePins,
        )
        const runtime = canonical(point.runtimeCodeHashes)
        if (firstRuntime === null) firstRuntime = runtime
        else check(runtime === firstRuntime, 'cohort_runtime_drift')
        save('point-' + w.anchor.source.blockNumber + '-wire.json', w.origins)
        points.push(point)
      }
      batches.push({
        batchIndex: batch,
        physicalStarts: receipt.physicalStarts,
        acquiredAtUtc: receipt.availableAtUtc,
        receiptFile: 'batch-' + batch + '-original-receipt.json',
      })
      control = null
      receipt = null
      process.stdout.write(
        JSON.stringify({
          phase: 'batch_replayed',
          batchIndex: batch,
          physicalStarts: actualStarts,
          points: points.length,
          ...FLAGS,
        }) + '\n',
      )
    }
    phase = 'final_retention'
    save('replayed-conversion-points.json', {
      schema: 'fluid_usdt_native_conversion_extension_replay_v1',
      points,
      batches,
      owner: null,
      ...FLAGS,
    })
    const local = {
      schema: 'fluid_usdt_conversion_extension_manifest_v1',
      files: [...state.files],
      incomplete: [...state.incomplete],
      accountedBytesBeforeManifest: state.accounted,
      producerSha256,
      planFileSha256: PLAN_FILE_SHA256,
      ...FLAGS,
    }
    save('local-artifact-manifest.json', { ...local, sha256: sha(canonical(local)) })
    before()
    check(actualStarts === 368 && points.length === 10 && state.incomplete.length === 0, 'complete')
    const terminal = {
      schema: 'fluid_usdt_conversion_extension_terminal_v1',
      complete: true,
      failure: null,
      phase: 'native_conversion_replayed',
      startedAtUtc,
      qualificationAtUtc: new Date(nativeNow()).toISOString(),
      completionScope: 'native_data_qualified_before_terminal_retention',
      completionClockBoundary: 'after_prior_fsync_and_source_gates_before_terminal_write',
      retentionCompletedAtUtc: null,
      physicalStarts: actualStarts,
      maxPhysicalStarts: 368,
      sdkPhysicalStarts: null,
      points: 10,
      censoredPoints: points.filter((p) => p.status !== 'conditional_native_quotes').length,
      batches,
      producerSha256,
      planFileSha256: PLAN_FILE_SHA256,
      files: [...state.files],
      accountedBytesBeforeTerminal: state.accounted,
      metadataInventoryBoundary:
        'after_prior_fsync_and_source_gates_before_terminal_write_self_excluded',
      ...FLAGS,
    }
    save('terminal.json', { ...terminal, sha256: sha(canonical(terminal)) }, true)
    const elapsedMs = performance.now() - started,
      completedAtUtc = new Date(nativeNow()).toISOString()
    cohortRetentionAllowed(elapsedMs, actualStarts, cohortExpired)
    return {
      out,
      complete: true,
      completedAtUtc,
      elapsedMs,
      completionClockBoundary: 'after_terminal_fsync_and_identity_gates',
      physicalStarts: actualStarts,
      points: 10,
      ...FLAGS,
    }
  } catch (error) {
    let reason = 'unclassified_failure'
    const message =
      error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'message')?.value
        : null
    if (typeof message === 'string' && /^fluid_usdt_extension_[a-z_0-9]+$/.test(message))
      reason = message
    if (control) {
      if (!receipt) {
        receipt = await control.finish()
        actualStarts += receipt.physicalStarts
      }
      try {
        retain(batches.length)
      } catch {}
    }
    const safeLedger =
      receipt?.ledger?.map((r) => ({
        physicalId: r.physicalId,
        host: r.host,
        status: r.status,
        bodyBytes: r.bodyBytes,
        bodySha256: r.bodySha256,
      })) ?? []
    const terminal = {
      schema: 'fluid_usdt_conversion_extension_terminal_v1',
      complete: false,
      failure: reason,
      phase,
      startedAtUtc,
      qualificationAtUtc: new Date(nativeNow()).toISOString(),
      completionScope: 'failure_observed_before_terminal_retention',
      completionClockBoundary: 'before_failure_terminal_write',
      retentionCompletedAtUtc: null,
      physicalStarts: actualStarts,
      maxPhysicalStarts: 368,
      sdkPhysicalStarts: null,
      points: points.length,
      batches,
      failedBatchSafeLedger: safeLedger,
      files: [...state.files],
      incomplete: [...state.incomplete],
      accountedBytesBeforeTerminal: state.accounted,
      producerSha256,
      planFileSha256: PLAN_FILE_SHA256,
      ...FLAGS,
    }
    try {
      save('terminal.json', { ...terminal, sha256: sha(canonical(terminal)) }, true)
    } catch {}
    return {
      out,
      complete: false,
      reason,
      completedAtUtc: new Date(nativeNow()).toISOString(),
      elapsedMs: performance.now() - started,
      completionClockBoundary: 'after_terminal_retention_attempt',
      physicalStarts: actualStarts,
      points: points.length,
      ...FLAGS,
    }
  } finally {
    clearTimeout(timer)
  }
}
export function main(args = process.argv.slice(2)) {
  check(Array.isArray(args) && args.length === 1 && args[0] === '--capture', 'manual_capture_flag')
  return captureFluidUsdtNativeConversionExtension()
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (r) => {
      process.stdout.write(JSON.stringify(r) + '\n')
      if (!r.complete) process.exitCode = 1
    },
    () => {
      process.stderr.write('fluid_usdt_extension_preflight_failed\n')
      process.exitCode = 1
    },
  )
}
