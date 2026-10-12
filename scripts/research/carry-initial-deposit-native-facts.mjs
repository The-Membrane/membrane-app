// Optional, source-pinned reserve facts. No new finalized source or owner witness.
import { createHash } from 'node:crypto'
import { createPublicClient, http, parseAbi } from 'viem'
import { readEnv } from '../lib/venue-reads.mjs'
import { selectedCompoundInitialDepositAgreement } from '../../lib/carry/compoundInitialDeposit.ts'
import {erc4626InitialDepositMarket,selectedErc4626InitialDepositAgreement} from '../../lib/carry/erc4626InitialDeposit.ts'
import {
  initialDepositMarket,
  selectedInitialDepositNativeAgreement,
} from '../../lib/carry/initialDepositCapacityProjection.ts'

const MAX = (1n << 256n) - 1n
const CACHE_TTL = 300000
const CACHE_LIMIT = 8
const READ_BUDGET_MS = 1500
const cache = new Map()
const pending = new Map()
const sha = (s) => createHash('sha256').update(s).digest('hex')
const unavailable = (reason) => ({ status: 'unavailable', reason })
const abi = parseAbi([
  'function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
  'function getReserveNormalizedIncome(address) view returns (uint256)',
  'function scaledTotalSupply() view returns (uint256)',
  'function baseToken() view returns (address)',
  'function decimals() view returns (uint8)',
  'function isSupplyPaused() view returns (bool)',
  'function totalsBasic() view returns (uint64 baseSupplyIndex,uint64 baseBorrowIndex,uint64 trackingSupplyIndex,uint64 trackingBorrowIndex,uint104 totalSupplyBase,uint104 totalBorrowBase,uint40 lastAccrualTime,uint8 pauseFlags)',
  'function getUtilization() view returns (uint256)',
  'function getSupplyRate(uint256) view returns (uint64)',
  'function asset() view returns (address)',
  'function previewDeposit(uint256) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function maxDeposit(address) view returns (uint256)',
])
function host(url) {
  try {
    const u = new URL(url)
    const h = u.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '')
    return u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      h &&
      !/^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(h)
      ? h
      : null
  } catch {
    return null
  }
}
const uint = (v) => typeof v === 'bigint' && v >= 0n && v <= MAX
function validSource(s, now) {
  const m = s && initialDepositMarket(s.routeKey, s.destination)
  return (
    m &&
    s.chainId === 1 &&
    s.asset === m.underlying.toLowerCase() &&
    s.assetDecimals === m.decimals &&
    typeof s.cashRaw === 'string' &&
    /^(0|[1-9][0-9]{0,77})$/.test(s.cashRaw) &&
    BigInt(s.cashRaw) <= MAX &&
    typeof s.block === 'string' &&
    /^[1-9][0-9]*$/.test(s.block) &&
    BigInt(s.block) <= MAX &&
    typeof s.blockHash === 'string' &&
    /^0x[a-f0-9]{64}$/.test(s.blockHash) &&
    ['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(s.sourceKind) &&
    Number.isSafeInteger(now) &&
    typeof s.blockTime === 'string' &&
    Number.isSafeInteger(Date.parse(s.blockTime)) &&
    typeof s.readAt === 'string' &&
    Number.isSafeInteger(Date.parse(s.readAt)) &&
    Date.parse(s.blockTime) <= Date.parse(s.readAt) &&
    Date.parse(s.readAt) <= now &&
    now - Date.parse(s.blockTime) <= 1800000
  )
}
function headerMatches(b, s) {
  return (
    b &&
    b.number === BigInt(s.block) &&
    typeof b.hash === 'string' &&
    b.hash.toLowerCase() === s.blockHash &&
    typeof b.timestamp === 'bigint' &&
    b.timestamp * 1000n === BigInt(Date.parse(s.blockTime))
  )
}

function acquisition(externalSignal) {
  const controller = new AbortController()
  let expired = false
  const result = new Promise((resolve) => {
    controller.signal.addEventListener(
      'abort',
      () =>
        resolve(
          unavailable(
            expired
              ? 'initial_deposit_native_read_timeout'
              : 'initial_deposit_native_read_cancelled',
          ),
        ),
      { once: true },
    )
  })
  const cancel = () => controller.abort()
  externalSignal?.addEventListener('abort', cancel, { once: true })
  if (externalSignal?.aborted) cancel()
  const timer = setTimeout(() => {
    expired = true
    cancel()
  }, READ_BUDGET_MS)
  return {
    signal: controller.signal,
    result,
    guard() {
      if (controller.signal.aborted) throw Error('native_acquisition_stopped')
    },
    dispose() {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', cancel)
      cancel()
    },
  }
}
async function boundedRead(read, work) {
  try {
    if (read.signal.aborted) return await read.result
    read.guard()
    return await Promise.race([work(), read.result])
  } catch {
    return unavailable('initial_deposit_native_read_failed')
  } finally {
    read.dispose()
  }
}
async function sharedReadResult(work, signal) {
  if (!signal) return work
  if (signal.aborted) return unavailable('initial_deposit_native_read_cancelled')
  let cancel
  const cancelled = new Promise((resolve) => {
    cancel = () => resolve(unavailable('initial_deposit_native_read_cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
  })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
async function sourceNativeFacts(source, { origins, clock = Date.now,depositAssetsRaw,receiver=null }, read) {
  try {
    const call = async (launch) => {
      read.guard()
      const value = await launch()
      read.guard()
      return value
    }
    if (!validSource(source, clock())) return unavailable('initial_deposit_source_invalid')
    if (
      !Array.isArray(origins) ||
      origins.length !== 2 ||
      origins.some((o) => !host(o.url) || !o.client) ||
      host(origins[0].url) === host(origins[1].url)
    )
      return unavailable('rpc_origins_unavailable')
    const m = initialDepositMarket(source.routeKey, source.destination),
      blockNumber = BigInt(source.block)
    const before = await Promise.all(
      origins.map((o) => call(() => o.client.getBlock({ blockNumber }))),
    )
    if (before.some((b) => !headerMatches(b, source)))
      return unavailable('native_source_header_disagreement')
    const facts = await Promise.all(
      origins.map(async ({ client }) => {
        if (erc4626InitialDepositMarket(source.routeKey,source.destination)) {
          if(typeof depositAssetsRaw!=='string'||!/^[1-9][0-9]{0,77}$/.test(depositAssetsRaw)||BigInt(depositAssetsRaw)>MAX||
            (receiver!==null&&!/^0x[0-9a-f]{40}$/.test(receiver)))throw Error('native_erc4626_question_invalid')
          const contract=(address,functionName,args=[])=>call(()=>client.readContract({address,abi,functionName,args,blockNumber}))
          const asset=await contract(source.destination,'asset'),assetDecimals=await contract(source.asset,'decimals'),shareDecimals=await contract(source.destination,'decimals')
          const minted=await contract(source.destination,'previewDeposit',[BigInt(depositAssetsRaw)])
          if(typeof asset!=='string'||asset.toLowerCase()!==source.asset||Number(assetDecimals)!==source.assetDecimals||!Number.isInteger(Number(shareDecimals))||Number(shareDecimals)<0||Number(shareDecimals)>36||!uint(minted)||minted===0n)throw Error('native_erc4626_identity_or_mint_invalid')
          const ea=await contract(source.destination,'previewRedeem',[minted])
          let max=null,maxDepositStatus=receiver===null?'not_requested':'unavailable'
          if(receiver!==null){try{max=await contract(source.destination,'maxDeposit',[receiver]);maxDepositStatus='quoted'}catch{read.guard()}}
          if(!uint(ea)||ea===0n||(max!==null&&!uint(max)))throw Error('native_erc4626_preview_invalid')
          return {vault:source.destination,asset:source.asset,assetDecimals:source.assetDecimals,shareDecimals:Number(shareDecimals),depositAssetsRaw,mintedSharesRaw:String(minted),entitlementRaw:String(ea),receiver,maxDepositRaw:max===null?null:String(max),maxDepositStatus}
        }
        if (source.routeKey === 'USDC → supply on Compound v3') {
          const contract = (functionName,args=[]) => call(()=>client.readContract({address:source.destination,abi,functionName,args,blockNumber}))
          const asset=await contract('baseToken'),decimals=await contract('decimals'),paused=await contract('isSupplyPaused')
          const totals=await contract('totalsBasic'),utilization=await contract('getUtilization'),rate=await contract('getSupplyRate',[utilization])
          const timestamp=BigInt(Date.parse(source.blockTime)/1000),last=totals[6],stored=totals[0]
          if(typeof asset!=='string'||asset.toLowerCase()!==source.asset||Number(decimals)!==6||typeof paused!=='boolean'||
            !uint(stored)||!uint(last)||!uint(rate)||last>timestamp||rate>=1n<<64n)throw Error('native_compound_facts_invalid')
          const accrued=stored+stored*rate*(timestamp-last)/10n**18n
          if(accrued===0n||accrued>=1n<<64n)throw Error('native_compound_index_overflow')
          return {comet:source.destination,asset:source.asset,assetDecimals:6,baseSupplyIndexRaw:String(accrued),supplyPaused:paused}
        }
        const reserve = await call(() =>
          client.readContract({
            address: m.pool,
            abi,
            functionName: 'getReserveData',
            args: [m.underlying],
            blockNumber,
          }),
        )
        const index = await call(() =>
          client.readContract({
            address: m.pool,
            abi,
            functionName: 'getReserveNormalizedIncome',
            args: [m.underlying],
            blockNumber,
          }),
        )
        const scaled = await call(() =>
          client.readContract({
            address: source.destination,
            abi,
            functionName: 'scaledTotalSupply',
            blockNumber,
          }),
        )
        if (
          !reserve ||
          typeof reserve.aTokenAddress !== 'string' ||
          reserve.aTokenAddress.toLowerCase() !== source.destination ||
          !uint(reserve.configuration) ||
          !uint(reserve.accruedToTreasury) ||
          reserve.accruedToTreasury >= 1n << 128n ||
          !uint(index) ||
          index === 0n ||
          !uint(scaled)
        )
          throw Error('native_facts_invalid')
        return {
          pool: m.pool,
          aToken: source.destination,
          asset: source.asset,
          assetDecimals: source.assetDecimals,
          configurationRaw: String(reserve.configuration),
          normalizedIncomeRaw: String(index),
          scaledTotalSupplyRaw: String(scaled),
          accruedToTreasuryScaledRaw: String(reserve.accruedToTreasury),
        }
      }),
    )
    const after = await Promise.all(
      origins.map((o) => call(() => o.client.getBlock({ blockNumber }))),
    )
    if (after.some((b) => !headerMatches(b, source)))
      return unavailable('native_source_header_changed')
    const now = clock()
    if (!validSource(source, now)) return unavailable('initial_deposit_source_stale')
    const result = {
      status: erc4626InitialDepositMarket(source.routeKey,source.destination) ? 'agreed_erc4626_initial_deposit_facts' : source.routeKey === 'USDC → supply on Compound v3' ? 'agreed_compound_initial_deposit_facts' : 'agreed_initial_deposit_native_facts',
      currentSource: structuredClone(source),
      readAt: new Date(now).toISOString(),
      origins: origins.map((o, i) => ({
        originHostSha256: sha(host(o.url)),
        facts: facts[i],
      })),
    }
    return (
      (erc4626InitialDepositMarket(source.routeKey,source.destination) ? selectedErc4626InitialDepositAgreement(result,source,depositAssetsRaw,receiver,now) : source.routeKey === 'USDC → supply on Compound v3' ? selectedCompoundInitialDepositAgreement(result,source,now) : selectedInitialDepositNativeAgreement(result, source, now)) ??
      unavailable('native_facts_disagreeing')
    )
  } catch {
    return unavailable('initial_deposit_native_read_failed')
  }
}

/** At most eight sequential requests per origin, with one shared finite acquisition budget. */
export async function readInitialDepositNativeFacts(source, options = {}) {
  const read = acquisition(options.signal)
  return boundedRead(read, () => sourceNativeFacts(source, options, read))
}

// Bound every response before handing bytes to viem. No redirects, retries or URL retention.
async function boundedFetch(input, init, acquisitionSignal) {
  const controller = new AbortController()
  const signals = [init?.signal, acquisitionSignal].filter(Boolean)
  const abort = () => controller.abort()
  for (const signal of signals) {
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  }
  try {
    if (controller.signal.aborted) throw Error('native_acquisition_stopped')
    const response = await fetch(input, { ...init, signal: controller.signal, redirect: 'error' })
    if (!response.body) throw Error('native_empty_response')
    const reader = response.body.getReader(),
      chunks = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 65536) throw Error('native_response_too_large')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      headers: response.headers,
    })
  } finally {
    for (const signal of signals) signal.removeEventListener('abort', abort)
  }
}
export async function readConfiguredInitialDepositNativeFacts(source, options = {}) {
  try {
    if (options.signal?.aborted) return unavailable('initial_deposit_native_read_cancelled')
    if (!validSource(source, (options.clock ?? Date.now)()))
      return unavailable('initial_deposit_source_invalid')
    let urls = options.rpcUrls
    if (urls === undefined) {
      const { configuredProviders, readProviderPolicy } =
        await import('./carry-depth-quote-archive.mjs')
      const policy = readProviderPolicy()
      if (policy.status !== 'active') return unavailable('rpc_origins_unavailable')
      const env = readEnv()
      urls = configuredProviders({ get: (k) => process.env[k] ?? env.get(k) }, policy)
        .map((o) => o.url)
        .join(',')
    }
    const selected = [],
      hosts = new Set()
    for (const item of String(urls ?? '').split(',')) {
      const url = item.trim(),
        h = host(url)
      if (!h || hosts.has(h)) continue
      selected.push(url)
      hosts.add(h)
      if (selected.length === 2) break
    }
    if (selected.length !== 2) return unavailable('rpc_origins_unavailable')
    // Facts at one immutable source survive a later cash read at that same
    // source. Their original read clocks are returned unchanged.
    const { readAt: _cashReadAt, ...sourceIdentity } = source
    const key = sha(JSON.stringify(sourceIdentity) + '\0' + selected.join('\0')+'\0'+JSON.stringify([options.depositAssetsRaw??null,options.receiver??null]))
    const cached = cache.get(key),
      now = (options.clock ?? Date.now)()
    if (
      options.cache !== false &&
      cached &&
      now - Date.parse(cached.readAt) <= CACHE_TTL &&
      (erc4626InitialDepositMarket(source.routeKey,source.destination) ? selectedErc4626InitialDepositAgreement(cached,source,options.depositAssetsRaw,options.receiver??null,now) : source.routeKey === 'USDC → supply on Compound v3' ? selectedCompoundInitialDepositAgreement(cached,source,now) : selectedInitialDepositNativeAgreement(cached, source, now))
    )
      return structuredClone(cached)
    if (pending.has(key)) return sharedReadResult(pending.get(key), options.signal)
    if (pending.size >= CACHE_LIMIT) return unavailable('too_many_initial_deposit_reads')
    const read = (async () => {
      const budget = acquisition(options.signal)
      try {
        const origins = selected.map((url) => ({
          url,
          client: options.clientFactory
            ? options.clientFactory(url)
            : createPublicClient({
                transport: http(url, {
                  timeout: 1500,
                  retryCount: 0,
                  fetchFn: (input, init) => boundedFetch(input, init, budget.signal),
                }),
              }),
        }))
        const result = await boundedRead(budget, () =>
          sourceNativeFacts(source, { ...options, origins }, budget),
        )
        if (options.cache !== false && ['agreed_initial_deposit_native_facts','agreed_compound_initial_deposit_facts','agreed_erc4626_initial_deposit_facts'].includes(result.status)) {
          if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
          cache.set(key, structuredClone(result))
        }
        return result
      } finally {
        budget.dispose()
      }
    })()
    pending.set(key, read)
    try {
      return await read
    } finally {
      pending.delete(key)
    }
  } catch {
    return unavailable('initial_deposit_native_read_failed')
  }
}
