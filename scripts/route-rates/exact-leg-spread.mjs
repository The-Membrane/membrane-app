// Exact-leg rate prototype. No persistence or scheduler side effects; the
// production recorder invokes it on a per-leg daily cadence.
// A spread here is the difference of two effective annualized rates; it is not
// a realized account return and excludes incentives, gas, entry and exit costs.
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
export const LOOKBACK_SECONDS = 7 * 24 * 60 * 60

export const GHO_SGHO = Object.freeze({
  chainId: 1,
  borrowProtocol: 'Aave V3',
  borrowMarket: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  borrowAsset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  destinationKind: 'ERC4626',
  destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
})

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAY = 10n ** 27n
const hex = (value) => `0x${BigInt(value).toString(16)}`
const addressArg = (value) => value.toLowerCase().slice(2).padStart(64, '0')
const shareArg = (value) => BigInt(value).toString(16).padStart(64, '0')
const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  // RPC clients often embed URL credentials in their thrown Error message.
  if (/https?:\/\/|api[-_]?key|bearer|token=/i.test(message)) return 'RPC or archive read failed'
  if (
    /^(Unsupported exact leg|Invalid [^\n]+|RPC chain mismatch|No finalized block|Finalized block unavailable|Prior block is not before finalized block|Prior archive block unavailable|Prior block is not within one hour of seven days|No archive block within one hour before seven-day target|Archive block unavailable at \d+|Vault asset unavailable|Vault asset differs from borrowed asset|Aave reserve rate unavailable|Vault share price unavailable at one or both blocks)$/.test(
      message,
    )
  )
    return message
  return 'RPC or archive read failed'
}

export function exactLegKey(leg) {
  if (leg.chainId !== 1 || leg.borrowProtocol !== 'Aave V3' || leg.destinationKind !== 'ERC4626') {
    throw new Error('Unsupported exact leg')
  }
  for (const field of ['borrowMarket', 'borrowAsset', 'destination']) {
    if (!ADDRESS.test(leg[field] || '')) throw new Error(`Invalid ${field}`)
  }
  if (
    !sameAddress(leg.borrowMarket, GHO_SGHO.borrowMarket) ||
    !sameAddress(leg.borrowAsset, GHO_SGHO.borrowAsset) ||
    !sameAddress(leg.destination, GHO_SGHO.destination)
  ) {
    throw new Error('Unsupported exact leg')
  }
  return [leg.chainId, leg.borrowProtocol, leg.borrowMarket, leg.borrowAsset, leg.destination]
    .map((part) => String(part).toLowerCase())
    .join(':')
}

export function aaveNominalAprToEffectiveApy(ray) {
  const apr = Number(BigInt(ray)) / Number(RAY)
  if (!Number.isFinite(apr) || apr < 0) throw new Error('Invalid Aave borrow rate')
  const apy = Math.expm1(SECONDS_PER_YEAR * Math.log1p(apr / SECONDS_PER_YEAR))
  if (!Number.isFinite(apy)) throw new Error('Invalid Aave effective APY')
  return apy
}

export function annualizeShareGrowth(currentAssets, priorAssets, elapsedSeconds) {
  const current = BigInt(currentAssets)
  const prior = BigInt(priorAssets)
  if (current <= 0n || prior <= 0n) throw new Error('Invalid share price')
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) throw new Error('Invalid lookback')
  // A raw ERC4626 asset quote commonly exceeds JS's safe integer range.
  const scaledRatio = Number((current * 10n ** 15n) / prior) / 1e15
  if (!Number.isFinite(scaledRatio) || scaledRatio <= 0)
    throw new Error('Invalid share-price ratio')
  const apy = Math.expm1((Math.log(scaledRatio) * SECONDS_PER_YEAR) / elapsedSeconds)
  if (!Number.isFinite(apy)) throw new Error('Invalid annualized share growth')
  return apy
}

// Find the newest archive block at or before the target timestamp. This is
// intentionally timestamp-based, not a fixed blocks-per-week approximation.
export async function findArchiveBlockAtOrBefore({ rpc, finalizedBlockNumber, targetTimestamp }) {
  let lo = 0n
  let hi = BigInt(finalizedBlockNumber)
  let best = null
  while (lo <= hi) {
    const mid = (lo + hi) / 2n
    const block = await rpc.request({ method: 'eth_getBlockByNumber', params: [hex(mid), false] })
    if (!block || BigInt(block.number) !== mid)
      throw new Error(`Archive block unavailable at ${mid}`)
    const timestamp = Number(BigInt(block.timestamp))
    if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid archive block timestamp')
    if (timestamp <= targetTimestamp) {
      best = { number: mid, timestamp }
      lo = mid + 1n
    } else {
      hi = mid - 1n
    }
  }
  if (!best || targetTimestamp - best.timestamp > 60 * 60)
    throw new Error('No archive block within one hour before seven-day target')
  return best
}

function result(
  leg,
  key,
  sampledAt,
  blockNumber,
  blockHash,
  priorBlockNumber,
  priorAt,
  values,
  error,
) {
  return {
    key,
    leg,
    status: error ? 'unavailable' : 'priced',
    asOf: sampledAt,
    blockNumber: blockNumber?.toString() ?? null,
    blockHash: blockHash ?? null,
    lookback: {
      seconds: priorAt == null ? null : sampledAt - priorAt,
      priorAt,
      priorBlockNumber: priorBlockNumber?.toString() ?? null,
    },
    rateConvention: 'effective APY, decimal fraction',
    borrowSource: 'Aave V3 currentVariableBorrowRate, nominal ray APR compounded per second',
    yieldSource:
      'ERC4626 convertToAssets share-price growth, realized trailing window; incentives excluded',
    borrowApy: values?.borrowApy ?? null,
    yieldApy: values?.yieldApy ?? null,
    spread: values ? values.yieldApy - values.borrowApy : null,
    error: error ?? null,
  }
}

// `rpc` only needs request({method,params}); callers control the provider.
// `priorBlockNumber` can be injected from a stored snapshot, otherwise a
// timestamp-bounded archive binary search resolves it. Missing history fails
// closed rather than quietly substituting a fixed blocks-per-week offset.
export async function collectExactLegSpread({ rpc, leg = GHO_SGHO, priorBlockNumber }) {
  let key
  try {
    key = exactLegKey(leg)
  } catch (error) {
    return result(leg, null, null, null, null, priorBlockNumber, null, null, safeError(error))
  }

  let head = null
  let currentBlock = null
  let priorBlock = null
  try {
    const chainId = BigInt(await rpc.request({ method: 'eth_chainId', params: [] }))
    if (chainId !== 1n) throw new Error('RPC chain mismatch')
    currentBlock = await rpc.request({
      method: 'eth_getBlockByNumber',
      params: ['finalized', false],
    })
    if (!currentBlock?.number || !/^0x[0-9a-fA-F]{64}$/.test(currentBlock.hash || ''))
      throw new Error('Finalized block unavailable')
    head = BigInt(currentBlock.number)
    const blockTag = hex(head)
    const sampledAt = Number(BigInt(currentBlock.timestamp))
    const resolvedPrior =
      priorBlockNumber == null
        ? await findArchiveBlockAtOrBefore({
            rpc,
            finalizedBlockNumber: head,
            targetTimestamp: sampledAt - LOOKBACK_SECONDS,
          })
        : null
    const prior = priorBlockNumber == null ? resolvedPrior.number : BigInt(priorBlockNumber)
    if (prior >= head) throw new Error('Prior block is not before finalized block')
    priorBlock = await rpc.request({ method: 'eth_getBlockByNumber', params: [hex(prior), false] })
    if (!priorBlock || BigInt(priorBlock.number) !== prior)
      throw new Error('Prior archive block unavailable')
    const priorAt = Number(BigInt(priorBlock.timestamp))
    const elapsed = sampledAt - priorAt
    if (Math.abs(elapsed - LOOKBACK_SECONDS) > 60 * 60)
      throw new Error('Prior block is not within one hour of seven days')

    const assetCall = await rpc.request({
      method: 'eth_call',
      params: [{ to: leg.destination, data: '0x38d52e0f' }, blockTag],
    })
    if (!assetCall || assetCall.length < 66) throw new Error('Vault asset unavailable')
    const vaultAsset = `0x${assetCall.slice(-40)}`
    if (!sameAddress(vaultAsset, leg.borrowAsset))
      throw new Error('Vault asset differs from borrowed asset')

    const reserve = await rpc.request({
      method: 'eth_call',
      params: [
        { to: leg.borrowMarket, data: `0x35ea6a75${addressArg(leg.borrowAsset)}` },
        blockTag,
      ],
    })
    const words = reserve?.slice(2).match(/.{64}/g)
    if (!words || words.length < 5) throw new Error('Aave reserve rate unavailable')
    const borrowRay = BigInt(`0x${words[4]}`)
    const shareCall = `0x07a2d13a${shareArg(10n ** 18n)}`
    const [currentAssets, priorAssets] = await Promise.all([
      rpc.request({
        method: 'eth_call',
        params: [{ to: leg.destination, data: shareCall }, blockTag],
      }),
      rpc.request({
        method: 'eth_call',
        params: [{ to: leg.destination, data: shareCall }, hex(prior)],
      }),
    ])
    if (!currentAssets || currentAssets === '0x' || !priorAssets || priorAssets === '0x')
      throw new Error('Vault share price unavailable at one or both blocks')
    const borrowApy = aaveNominalAprToEffectiveApy(borrowRay)
    const yieldApy = annualizeShareGrowth(currentAssets, priorAssets, elapsed)
    if (!Number.isFinite(yieldApy - borrowApy)) throw new Error('Invalid annualized spread')
    return result(
      leg,
      key,
      sampledAt,
      head,
      currentBlock.hash,
      prior,
      priorAt,
      { borrowApy, yieldApy },
      null,
    )
  } catch (error) {
    return result(
      leg,
      key,
      currentBlock?.timestamp ? Number(BigInt(currentBlock.timestamp)) : null,
      head,
      currentBlock?.hash ?? null,
      priorBlock ? BigInt(priorBlock.number) : priorBlockNumber,
      priorBlock ? Number(BigInt(priorBlock.timestamp)) : null,
      null,
      safeError(error),
    )
  }
}
