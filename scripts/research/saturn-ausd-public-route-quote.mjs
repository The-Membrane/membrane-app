// Fixed-block, two-origin quote for the public USDat -> USDC -> AUSD exit leg.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries, writeExclusive } from './apyusd-receipt-cohort-source.mjs'

export const OUT = resolve('data/research/venue-signals/saturn-ausd-public-route-quote-v1.json')
export const BLOCK = 26_107_302
export const CURVE = '0xf4d0cf32908b2c7f1021339c43df0f77f06896d7'
export const UNISWAP = '0xbafead7c60ea473758ed6c6021505e8bbd7e8e5d'
export const QUOTER = '0x61ffe014ba17989e743c5f6cb21bf9697530b21e'
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const USDAT = '0x23238f20b894f29041f48d88ee91131c395aaa71'
export const AUSD = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a'
const FEE = 100
const SIZES = [1_000, 100_000, 1_000_000, 4_000_000]
const ORIGINS = ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com']
const CURVE_ABI = parseAbi([
  'function coins(uint256 i) view returns (address)',
  'function balances(uint256 i) view returns (uint256)',
  'function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)',
])
const UNISWAP_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
])
const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
])
const sha = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const blockTag = `0x${BLOCK.toString(16)}`

async function call(origin, to, abi, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args })
  const result = await requestWithRetries(origin, 'eth_call', [{ to, data }, blockTag])
  return decodeFunctionResult({ abi, functionName, data: result })
}

async function readOrigin(origin) {
  const [curve0, curve1, curveCashUsdc, curveCashUsdat, pool0, pool1, liquidity] =
    await Promise.all([
      call(origin, CURVE, CURVE_ABI, 'coins', [0n]),
      call(origin, CURVE, CURVE_ABI, 'coins', [1n]),
      call(origin, CURVE, CURVE_ABI, 'balances', [0n]),
      call(origin, CURVE, CURVE_ABI, 'balances', [1n]),
      call(origin, UNISWAP, UNISWAP_ABI, 'token0'),
      call(origin, UNISWAP, UNISWAP_ABI, 'token1'),
      call(origin, UNISWAP, UNISWAP_ABI, 'liquidity'),
    ])
  if (
    curve0.toLowerCase() !== USDC ||
    curve1.toLowerCase() !== USDAT ||
    [pool0.toLowerCase(), pool1.toLowerCase()].sort().join(':') !== [AUSD, USDC].sort().join(':')
  )
    throw Error('saturn_public_route_token_identity_invalid')
  const sizes = []
  for (const usdat of SIZES) {
    const usdatRaw = BigInt(usdat) * 1_000_000n
    const usdcRaw = await call(origin, CURVE, CURVE_ABI, 'get_dy', [1n, 0n, usdatRaw])
    const quote = await call(origin, QUOTER, QUOTER_ABI, 'quoteExactInputSingle', [
      { tokenIn: USDC, tokenOut: AUSD, amountIn: usdcRaw, fee: FEE, sqrtPriceLimitX96: 0n },
    ])
    sizes.push({
      usdatRaw: usdatRaw.toString(),
      usdcQuotedRaw: usdcRaw.toString(),
      ausdQuotedRaw: quote[0].toString(),
      initializedTicksCrossed: quote[2],
    })
  }
  return {
    curveCashUsdcRaw: curveCashUsdc.toString(),
    curveCashUsdatRaw: curveCashUsdat.toString(),
    uniswapActiveLiquidityRaw: liquidity.toString(),
    sizes,
  }
}

export function verifyRow(row) {
  if (
    row?.study !== 'saturn_ausd_public_route_quote_v1' ||
    row.blockNumber !== BLOCK ||
    JSON.stringify(row.origins) !== JSON.stringify(ORIGINS) ||
    row.curve !== CURVE ||
    row.uniswap !== UNISWAP ||
    row.quoter !== QUOTER ||
    row.fee !== FEE ||
    row.usdc !== USDC ||
    row.usdat !== USDAT ||
    row.ausd !== AUSD ||
    row.sizes?.length !== SIZES.length ||
    !/^\d+$/.test(row.curveCashUsdcRaw ?? '') ||
    !/^\d+$/.test(row.curveCashUsdatRaw ?? '') ||
    !/^\d+$/.test(row.uniswapActiveLiquidityRaw ?? '')
  )
    throw Error('saturn_public_route_quote_invalid')
  for (let i = 0; i < SIZES.length; i++) {
    const size = row.sizes[i]
    if (
      size.usdatRaw !== (BigInt(SIZES[i]) * 1_000_000n).toString() ||
      !/^\d+$/.test(size.usdcQuotedRaw ?? '') ||
      !/^\d+$/.test(size.ausdQuotedRaw ?? '') ||
      BigInt(size.usdcQuotedRaw) <= 0n ||
      BigInt(size.ausdQuotedRaw) <= 0n ||
      !Number.isSafeInteger(size.initializedTicksCrossed)
    )
      throw Error('saturn_public_route_size_invalid')
  }
  const { sha256, ...body } = row
  if (sha256 !== sha(body)) throw Error('saturn_public_route_hash_invalid')
  return row
}

export async function verifySaved(out = OUT) {
  const bytes = await readFile(out, 'utf8')
  if (bytes.length > 8_192) throw Error('saturn_public_route_oversize')
  const row = verifyRow(JSON.parse(bytes))
  if (bytes !== `${JSON.stringify(row)}\n`) throw Error('saturn_public_route_encoding_invalid')
  return row
}

export async function capture({ urls = configuredPublicRpcUrls(readEnv()), out = OUT } = {}) {
  const clients = publicRpcClients(urls)
  const origins = ORIGINS.map((host) => clients.find((client) => new URL(client.url).host === host))
  if (origins.some((origin) => !origin)) throw Error('saturn_public_route_origin_missing')
  const [a, b] = await Promise.all(origins.map(readOrigin))
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error('saturn_public_route_origin_disagreement')
  const body = {
    study: 'saturn_ausd_public_route_quote_v1',
    blockNumber: BLOCK,
    origins: ORIGINS,
    curve: CURVE,
    uniswap: UNISWAP,
    quoter: QUOTER,
    fee: FEE,
    usdc: USDC,
    usdat: USDAT,
    ausd: AUSD,
    ...a,
  }
  const row = { ...body, sha256: sha(body) }
  verifyRow(row)
  await writeExclusive(out, row)
  return verifySaved(out)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  const row = mode === '--run' ? await capture() : mode === '--verify' ? await verifySaved() : null
  if (!row) throw Error('usage: --run | --verify')
  console.log(
    JSON.stringify({ sha256: row.sha256, blockNumber: row.blockNumber, sizes: row.sizes }),
  )
}
