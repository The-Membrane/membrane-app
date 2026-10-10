// Read-only, bounded follow-up for the two frozen Morpho Blue Panic(0x11) calls.
// It records the failing withdraw calldata and *historical* position, not an exit-risk verdict.
// node scripts/research/morpho-v2-route-panic-position.mjs
// node scripts/research/morpho-v2-route-panic-position.mjs --verify offline
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-route-panic-position-v1'
export const DRILLDOWN_SHA = 'a0846285783554dcadb6fe800fd4848b150e55d73d34becc9efa37660601dfb2'
export const FOLLOWTHROUGH_SHA = '431e3272d96edb351d13126bb6f152e7a6c8dbd8bedab3792d50e1be9c703dc2'
export const MORPHO = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'
export const WITHDRAW_SELECTOR = '0x5c2bea49'
const RESERVE_BYTES = 2_500_000_000
const MAX_OUTPUT_BYTES = 64 * 1024
const ADDRESS = /^0x[\da-f]{40}$/i
const HASH = /^0x[\da-f]{64}$/i
const PANIC = /^0x4e487b71[\da-f]{64}$/i
const VAULT_ABI = parseAbi(['function withdraw(uint256 assets,address receiver,address onBehalf) returns (uint256)'])
const BLUE_ABI = parseAbi([
  'function withdraw((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,address receiver) returns (uint256,uint256)',
  'function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)',
])
const ADAPTER_ABI = parseAbi(['function supplyShares(bytes32 id) view returns (uint256)'])
const PARAMS_ABI = [{ type: 'tuple', components: [
  { name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' },
  { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' },
  { name: 'lltv', type: 'uint256' },
] }]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unseal = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({ ...unseal(value), checkpointSha256: sha(JSON.stringify(unseal(value))) })
const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const dec = (x) => BigInt(x).toString()

function pinned(path, expected, label) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error(`${label} SHA mismatch`)
  return JSON.parse(bytes)
}
function atomicBounded(path, value) {
  const bytes = JSON.stringify(value)
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES) throw new Error('Output size cap reached')
  mkdirSync(dirname(path), { recursive: true })
  const disk = statfsSync(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Disk reserve reached')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
}

export function selectIncidents(drilldown, followthrough) {
  if (drilldown?.study !== 'morpho-v2-route-exit-panic-drilldown-v1' ||
      followthrough?.study !== 'morpho-v2-route-exit-followthrough-first20-v1' ||
      drilldown.chainId !== 1 || followthrough.chainId !== 1 ||
      drilldown.status !== 'complete' || followthrough.status !== 'complete' ||
      drilldown.followthroughSha256 !== FOLLOWTHROUGH_SHA ||
      drilldown.results?.length !== 2) throw new Error('Frozen source mismatch')
  return drilldown.results.map((row, i) => {
    const matched = followthrough.results?.find((r) => r.index === row.index)
    if (row.index !== [15, 18][i] ||
        !matched || matched.status !== 'b-evm-revert' || matched.errorSelector !== '0x4e487b71' ||
        matched.block !== row.block || matched.vault !== row.vault ||
        matched.holder !== row.holder || matched.qAssets !== row.qAssets ||
        matched.blockHash?.toLowerCase() !== row.blockHash ||
        row.trace?.status !== 'ok' || row.trace.panicCode !== '17' ||
        !row.trace.failurePath?.some((p) => p.to === MORPHO && p.inputSelector === WITHDRAW_SELECTOR) ||
        !ADDRESS.test(row.vault) || !ADDRESS.test(row.holder) || !ADDRESS.test(row.adapter) ||
        !HASH.test(row.blockHash) || !/^\d+$/.test(row.qAssets) || BigInt(row.qAssets) <= 0n)
      throw new Error('Frozen panic case mismatch')
    return { index: row.index, block: row.block, blockHash: row.blockHash,
      vault: row.vault, holder: row.holder, qAssets: row.qAssets, adapter: row.adapter }
  })
}

// Extract only the exact reverting Morpho Blue call. Never persist a raw trace.
export function extractFailingWithdraw(root, expectedAdapter) {
  let nodes = 0
  const matches = []
  function visit(call, depth) {
    if (!call || typeof call !== 'object' || ++nodes > 2000 || depth > 48)
      throw new Error('Trace complexity cap reached')
    if (sameAddress(call.to, MORPHO) &&
        String(call.input || '').slice(0, 10).toLowerCase() === WITHDRAW_SELECTOR &&
        sameAddress(call.from, expectedAdapter) && call.error && PANIC.test(call.output || ''))
      matches.push(call)
    if (call.calls && !Array.isArray(call.calls)) throw new Error('Invalid trace shape')
    if (call.calls?.length > 2000) throw new Error('Trace fanout cap reached')
    for (const child of call.calls || []) visit(child, depth + 1)
  }
  visit(root, 0)
  if (matches.length !== 1) throw new Error('Expected exactly one failing adapter-to-Blue withdraw')
  const call = matches[0]
  if (BigInt(`0x${call.output.slice(10)}`) !== 17n) throw new Error('Unexpected Panic code')
  const decoded = decodeFunctionData({ abi: BLUE_ABI, data: call.input })
  if (decoded.functionName !== 'withdraw') throw new Error('Wrong Blue selector')
  const [p, assets, shares, onBehalf, receiver] = decoded.args
  const params = { loanToken: p.loanToken, collateralToken: p.collateralToken,
    oracle: p.oracle, irm: p.irm, lltv: dec(p.lltv) }
  const marketId = keccak256(encodeAbiParameters(PARAMS_ABI, [{ ...params, lltv: BigInt(params.lltv) }]))
  return { nodes, panicCode: '17', marketId, marketParams: params,
    assets: dec(assets), shares: dec(shares), onBehalf, receiver,
    calldataSha256: sha(Buffer.from(call.input.slice(2), 'hex')) }
}

export function validateOutput(saved, selected) {
  if (saved?.study !== STUDY || saved.chainId !== 1 || saved.status !== 'complete' ||
      saved.drilldownSha256 !== DRILLDOWN_SHA || saved.followthroughSha256 !== FOLLOWTHROUGH_SHA ||
      JSON.stringify(saved.incidents) !== JSON.stringify(selected) || saved.results?.length !== 2 ||
      saved.checkpointSha256 !== sha(JSON.stringify(unseal(saved))))
    throw new Error('Position checkpoint mismatch')
  for (let i = 0; i < 2; i++) {
    const source = selected[i], r = saved.results[i]
    if (r.index !== source.index || r.block !== source.block || r.blockHash !== source.blockHash ||
        r.vault !== source.vault || r.adapter !== source.adapter ||
        !HASH.test(r.withdraw?.marketId) || !/^[\da-f]{64}$/.test(r.withdraw?.calldataSha256) ||
        r.withdraw.panicCode !== '17' || r.withdraw.nodes > 2000 ||
        !sameAddress(r.withdraw.onBehalf, source.adapter) ||
        !/^\d+$/.test(r.positionSupplyShares) ||
        !/^\d+$/.test(r.adapterSupplyShares) ||
        !/^\d+$/.test(r.marketTotalSupplyAssets) ||
        !/^\d+$/.test(r.marketTotalSupplyShares) ||
        !/^\d+$/.test(r.marketTotalBorrowAssets) ||
        !/^\d+$/.test(r.marketTotalBorrowShares))
      throw new Error('Position row mismatch')
  }
  return saved
}
export function verifyOffline({ drilldownPath, followthroughPath, out }) {
  const selected = selectIncidents(pinned(drilldownPath, DRILLDOWN_SHA, 'Drilldown'),
    pinned(followthroughPath, FOLLOWTHROUGH_SHA, 'Follow-through'))
  return validateOutput(JSON.parse(readFileSync(out, 'utf8')), selected)
}
export async function run({ client, drilldownPath, followthroughPath, out }) {
  const selected = selectIncidents(pinned(drilldownPath, DRILLDOWN_SHA, 'Drilldown'),
    pinned(followthroughPath, FOLLOWTHROUGH_SHA, 'Follow-through'))
  if (existsSync(out)) return validateOutput(JSON.parse(readFileSync(out, 'utf8')), selected)
  if (await client.getChainId() !== 1) throw new Error('Wrong chain ID')
  const results = []
  for (const incident of selected) {
    const blockNumber = BigInt(incident.block)
    const header = await client.getBlock({ blockNumber })
    if (header.number !== blockNumber || !sameAddress(header.hash, incident.blockHash))
      throw new Error('Pinned B block mismatch')
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'withdraw',
      args: [BigInt(incident.qAssets), incident.holder, incident.holder] })
    const raw = await client.request({ method: 'debug_traceCall', params: [
      { from: incident.holder, to: incident.vault, data, gas: toHex(20_000_000) },
      toHex(blockNumber), { tracer: 'callTracer', timeout: '10s' },
    ] })
    const withdraw = extractFailingWithdraw(raw, incident.adapter)
    if (!sameAddress(withdraw.onBehalf, incident.adapter))
      throw new Error('Blue onBehalf differs from selected adapter')
    const read = (address, functionName, args, abi = BLUE_ABI) =>
      client.readContract({ address, abi, functionName, args, blockNumber })
    const [position, market, params, adapterSupplyShares] = await Promise.all([
      read(MORPHO, 'position', [withdraw.marketId, withdraw.onBehalf]),
      read(MORPHO, 'market', [withdraw.marketId]),
      read(MORPHO, 'idToMarketParams', [withdraw.marketId]),
      read(incident.adapter, 'supplyShares', [withdraw.marketId], ADAPTER_ABI),
    ])
    if (![params[0], params[1], params[2], params[3]].every((x, j) =>
      sameAddress(x, [withdraw.marketParams.loanToken, withdraw.marketParams.collateralToken,
        withdraw.marketParams.oracle, withdraw.marketParams.irm][j])) ||
      dec(params[4]) !== withdraw.marketParams.lltv || dec(market[4]) === '0')
      throw new Error('Market ID/params cross-check failed')
    results.push({ index: incident.index, block: incident.block, blockHash: incident.blockHash,
      vault: incident.vault, adapter: incident.adapter, withdraw,
      positionSupplyShares: dec(position[0]), adapterSupplyShares: dec(adapterSupplyShares),
      marketTotalSupplyAssets: dec(market[0]), marketTotalSupplyShares: dec(market[1]),
      marketTotalBorrowAssets: dec(market[2]), marketTotalBorrowShares: dec(market[3]),
      marketLastUpdate: dec(market[4]), marketFee: dec(market[5]) })
  }
  const saved = seal({ study: STUDY, chainId: 1, status: 'complete',
    drilldownSha256: DRILLDOWN_SHA, followthroughSha256: FOLLOWTHROUGH_SHA,
    incidents: selected, results })
  validateOutput(saved, selected)
  atomicBounded(out, saved)
  return saved
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const paths = {
    drilldownPath: resolve('data/research/venue-signals/morpho-v2-route-exit-panic-drilldown.json'),
    followthroughPath: resolve('data/research/venue-signals/morpho-v2-route-exit-followthrough-first20.json'),
    out: resolve('data/research/venue-signals/morpho-v2-route-panic-position.json'),
  }
  try {
    if (args.length && args.join(' ') !== '--verify offline') throw new Error('Unsupported arguments')
    const saved = args.length ? verifyOffline(paths) : await run({ ...paths,
      client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify({ status: saved.status, rows: saved.results.length,
      sha256: sha(readFileSync(paths.out)) }) + '\n')
  } catch {
    process.stderr.write('Panic position probe stopped; no result was published.\n')
    process.exitCode = 1
  }
}
