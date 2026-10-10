// Counterfactual same-state holder withdrawal -> Curve swaps. Never a mainnet fill.
// Dry by default. Running requires a sealed v2 quote, target attestation and pre-B plan.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'
import { readValidatedCheckpoints, sourceIdentity, STUDY_V2 } from './curve-prospective-quote.mjs'
import { parseEip1167Runtime, validateAttestation } from './scrvusd-target-code-attestation.mjs'
import { readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'scrvusd-stateful-fork-exit-v1'
export const RESERVE_BYTES = 2_684_354_560 // 2.5 GiB before fork or RPC, also before seal.
export const OUT = resolve('data/research/venue-signals/scrvusd-stateful-fork-exit')
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function withdraw(uint256,address,address) returns (uint256)',
  'function coins(uint256) view returns (address)',
  'function get_dy(int128,int128,uint256) view returns (uint256)',
  'function exchange(int128,int128,uint256,uint256,address) returns (uint256)',
])
const sha = (v) => createHash('sha256').update(v).digest('hex')
const lower = (v) => String(v).toLowerCase()
const unsigned = ({ sha256: _seal, ...rest }) => rest
const seal = (v) => ({ ...v, sha256: sha(JSON.stringify(v)) })
const caveat =
  'Local fork counterfactual at exact historical B; impersonation and ETH gas funding are artificial. The deployed Curve exchange ABI was not independently source-attested; successful fork transaction plus token deltas is only behavioral evidence at B. This does not prove signer control, mainnet inclusion, future liquidity, MEV bound, or USD value. USDT and USDC are separate raw token outputs.'

export function diskGuard(out = OUT, stat = statfsSync, extra = 0) {
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('fork_disk_reserve')
}

export function makePlan({ holder, rawCrvUsd, sharesBps, minOutputBps, createdUtc }) {
  const plan = seal({
    study: STUDY,
    kind: 'predeclared-route-plan',
    holder: lower(holder),
    rawCrvUsd: String(rawCrvUsd),
    sharesBps,
    minOutputBps,
    createdUtc,
    caveat: 'Local plan clock is operator-reported, not externally witnessed.',
  })
  return validatePlan(plan)
}

export function savePlan({ plan, path, stat = statfsSync }) {
  validatePlan(plan)
  const bytes = `${JSON.stringify(plan)}\n`
  diskGuard(dirname(path), stat, Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(tmp, path)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
  return { path, physicalSha256: sha(bytes) }
}

export function validatePlan(plan) {
  if (
    !plan ||
    plan.sha256 !== sha(JSON.stringify(unsigned(plan))) ||
    plan.study !== STUDY ||
    plan.kind !== 'predeclared-route-plan' ||
    !ADDRESS.test(plan.holder) ||
    !RAW.test(plan.rawCrvUsd) ||
    BigInt(plan.rawCrvUsd) <= 0n ||
    !Array.isArray(plan.sharesBps) ||
    !plan.sharesBps.length ||
    plan.sharesBps.length > 5 ||
    new Set(plan.sharesBps).size !== plan.sharesBps.length ||
    plan.sharesBps.some((v) => !Number.isInteger(v) || v < 0 || v > 10000) ||
    !Number.isInteger(plan.minOutputBps) ||
    plan.minOutputBps < 0 ||
    plan.minOutputBps > 10000 ||
    !Number.isFinite(Date.parse(plan.createdUtc)) ||
    plan.caveat !== 'Local plan clock is operator-reported, not externally witnessed.'
  )
    throw new Error('Invalid predeclared route plan')
  return plan
}

function readPhysical(path, expectedSha) {
  if (!SHA.test(expectedSha)) throw new Error('Missing physical SHA-256')
  const bytes = readFileSync(path)
  if (sha(bytes) !== expectedSha) throw new Error('Physical source SHA mismatch')
  const value = JSON.parse(bytes.toString('utf8'))
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`)))
    throw new Error('Noncanonical physical source bytes')
  return value
}

export function loadSources({
  quotePath,
  quoteSha256,
  targetPath,
  targetSha256,
  planPath,
  planSha256,
  identity = sourceIdentity(),
}) {
  const quote = readPhysical(quotePath, quoteSha256)
  const rows = readValidatedCheckpoints({ out: dirname(quotePath), identity })
  const row = rows.find(
    (r) => r.filename === basename(quotePath) && r.physicalSha256 === quoteSha256,
  )
  if (!row || quote.study !== STUDY_V2) throw new Error('Verified v2 quote required')
  const target = readPhysical(targetPath, targetSha256)
  if (basename(targetPath) !== row.filename)
    throw new Error('Attestation checkpoint filename mismatch')
  validateAttestation(target, { identity, checkpoints: [row], nowUtc: new Date().toISOString() })
  const plan = validatePlan(readPhysical(planPath, planSha256))
  if (Date.parse(plan.createdUtc) > row.checkpoint.block.timestamp * 1000)
    throw new Error('Plan is not pre-B')
  return {
    row,
    target,
    plan,
    refs: { quotePath, quoteSha256, targetPath, targetSha256, planPath, planSha256 },
  }
}

function num(value) {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC number')
  return n
}
function block(value) {
  const b = {
    number: num(value?.number),
    hash: lower(value?.hash),
    timestamp: num(value?.timestamp),
  }
  if (!HASH.test(b.hash)) throw new Error('Malformed fork block')
  return b
}
function exact(actual, expected) {
  if (JSON.stringify(block(actual)) !== JSON.stringify(expected))
    throw new Error('Fork B/hash mismatch')
}
const hex = (n) => `0x${BigInt(n).toString(16)}`
function raw(value) {
  const s = String(value)
  if (!RAW.test(s)) throw new Error('Malformed raw amount')
  return BigInt(s)
}

async function rpc(session, method, params = []) {
  return session.request(method, params)
}
async function read(session, to, functionName, args = []) {
  const data = encodeFunctionData({ abi: ABI, functionName, args })
  const result = await rpc(session, 'eth_call', [{ to, data }, 'latest'])
  if (!HEX.test(lower(result)) || result === '0x') throw new Error('Invalid fork eth_call result')
  return decodeFunctionResult({ abi: ABI, functionName, data: result })
}
async function balances(session, identity, holder) {
  const [shares, crvUsd, usdt, usdc] = await Promise.all([
    read(session, identity.vault, 'balanceOf', [holder]),
    read(session, identity.crvUsd, 'balanceOf', [holder]),
    read(session, identity.pools[0].coin0, 'balanceOf', [holder]),
    read(session, identity.pools[1].coin0, 'balanceOf', [holder]),
  ])
  return {
    sharesRaw: String(shares),
    crvUsdRaw: String(crvUsd),
    usdtRaw: String(usdt),
    usdcRaw: String(usdc),
  }
}

async function transaction(session, from, to, data, stage, anchorBlock) {
  const hash = await rpc(session, 'eth_sendTransaction', [{ from, to, data, gas: '0x7a1200' }])
  if (!HASH.test(lower(hash))) throw new Error(`${stage}_invalid_transaction_hash`)
  let receipt = null
  for (let i = 0; i < 60; i++) {
    receipt = await rpc(session, 'eth_getTransactionReceipt', [hash])
    if (receipt) break
    await new Promise((done) => setTimeout(done, 100))
  }
  if (!receipt || lower(receipt.transactionHash) !== lower(hash))
    throw new Error(`${stage}_missing_receipt`)
  const receiptBlock = num(receipt.blockNumber)
  if (
    lower(receipt.from) !== lower(from) ||
    lower(receipt.to) !== lower(to) ||
    !HASH.test(lower(receipt.blockHash)) ||
    receiptBlock <= anchorBlock
  )
    throw new Error(`${stage}_receipt_identity_mismatch`)
  const minedBlock = await rpc(session, 'eth_getBlockByNumber', [hex(receiptBlock), false])
  if (
    num(minedBlock?.number) !== receiptBlock ||
    lower(minedBlock?.hash) !== lower(receipt.blockHash)
  )
    throw new Error(`${stage}_receipt_block_mismatch`)
  const row = {
    stage,
    transactionHash: lower(hash),
    status: receipt.status,
    gasUsedRaw: String(BigInt(receipt.gasUsed)),
    blockNumber: receiptBlock,
    blockHash: lower(receipt.blockHash),
    from: lower(receipt.from),
    to: lower(receipt.to),
    calldata: data,
  }
  if (receipt.status !== '0x1')
    throw Object.assign(new Error(`${stage}_reverted`), { receipt: row })
  return row
}

async function verifyFork(session, row, target, identity, holder) {
  if (num(await rpc(session, 'eth_chainId')) !== identity.chainId)
    throw new Error('Fork chain ID mismatch')
  const at = row.checkpoint.block
  exact(await rpc(session, 'eth_getBlockByNumber', [hex(at.number), false]), at)
  if (num(await rpc(session, 'eth_blockNumber')) !== at.number)
    throw new Error('Fork did not start at B')
  const addresses = [
    identity.vault,
    identity.crvUsd,
    identity.pools[0].coin0,
    identity.pools[1].coin0,
    ...identity.pools.map((p) => p.address),
  ]
  for (let i = 0; i < addresses.length; i++) {
    const code = lower(await rpc(session, 'eth_getCode', [addresses[i], 'latest']))
    if (
      !HEX.test(code) ||
      code === '0x' ||
      sha(Buffer.from(code.slice(2), 'hex')) !== row.checkpoint.raw.codeIdentities[i].codeSha256
    )
      throw new Error('Fork runtime differs from quote')
    if (i === 0 && (code !== target.vaultRuntime || parseEip1167Runtime(code) !== target.target))
      throw new Error('Fork vault target differs')
  }
  const targetCode = lower(await rpc(session, 'eth_getCode', [target.target, 'latest']))
  if (targetCode !== target.targetCode || keccak256(targetCode) !== target.targetCodeHash)
    throw new Error('Fork implementation differs')
  if (lower(await rpc(session, 'eth_getCode', [holder, 'latest'])) !== '0x')
    throw new Error('Contract holder cannot be impersonated as an EOA')
  if (lower(await read(session, identity.vault, 'asset')) !== identity.crvUsd)
    throw new Error('Fork vault asset differs')
  for (const p of identity.pools) {
    if (
      lower(await read(session, p.address, 'coins', [0n])) !== p.coin0 ||
      lower(await read(session, p.address, 'coins', [1n])) !== p.coin1
    )
      throw new Error('Fork pool orientation differs')
  }
}

async function oneRoute(session, { identity, row, target, plan, shareBps, baselineSnapshot }) {
  const holder = plan.holder
  const route = {
    shareBps,
    status: 'unavailable',
    failedStage: null,
    transactions: [],
    gasOverride: null,
    before: null,
    afterWithdraw: null,
    after: null,
    output: null,
    caveat,
  }
  let stage = 'reset'
  try {
    if ((await rpc(session, 'evm_revert', [baselineSnapshot])) !== true)
      throw new Error('Fork reset failed')
    const nextSnapshot = await rpc(session, 'evm_snapshot')
    await verifyFork(session, row, target, identity, holder)
    stage = 'gas_override'
    const nativeBefore = BigInt(await rpc(session, 'eth_getBalance', [holder, 'latest']))
    const funded = 10n ** 18n
    const nativeAfter = nativeBefore > funded ? nativeBefore : funded
    await rpc(session, 'anvil_setBalance', [holder, hex(nativeAfter)])
    await rpc(session, 'anvil_impersonateAccount', [holder])
    route.gasOverride = {
      nativeBeforeRaw: String(nativeBefore),
      nativeAfterRaw: String(nativeAfter),
      artificialWeiRaw: String(nativeAfter - nativeBefore),
    }
    route.before = await balances(session, identity, holder)
    stage = 'withdraw'
    const q = raw(plan.rawCrvUsd)
    route.transactions.push(
      await transaction(
        session,
        holder,
        identity.vault,
        encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [q, holder, holder] }),
        stage,
        row.checkpoint.block.number,
      ),
    )
    route.afterWithdraw = await balances(session, identity, holder)
    if (
      raw(route.afterWithdraw.crvUsdRaw) - raw(route.before.crvUsdRaw) !== q ||
      raw(route.before.sharesRaw) <= raw(route.afterWithdraw.sharesRaw) ||
      route.afterWithdraw.usdtRaw !== route.before.usdtRaw ||
      route.afterWithdraw.usdcRaw !== route.before.usdcRaw
    )
      throw new Error('Withdrawal delta differs from q, shares, or unchanged stablecoin balances')
    const usdtInput = (q * BigInt(shareBps)) / 10000n
    const inputs = [usdtInput, q - usdtInput]
    for (let i = 0; i < 2; i++) {
      if (inputs[i] === 0n) continue
      const pool = identity.pools[i]
      stage = i ? 'approve_usdc_pool' : 'approve_usdt_pool'
      route.transactions.push(
        await transaction(
          session,
          holder,
          identity.crvUsd,
          encodeFunctionData({
            abi: ABI,
            functionName: 'approve',
            args: [pool.address, inputs[i]],
          }),
          stage,
          row.checkpoint.block.number,
        ),
      )
      if (
        BigInt(await read(session, identity.crvUsd, 'allowance', [holder, pool.address])) <
        inputs[i]
      )
        throw new Error('Approval allowance insufficient')
      stage = i ? 'swap_usdc' : 'swap_usdt'
      const quoted = BigInt(await read(session, pool.address, 'get_dy', [1n, 0n, inputs[i]]))
      const minDy = (quoted * BigInt(plan.minOutputBps)) / 10000n
      route.transactions.push(
        await transaction(
          session,
          holder,
          pool.address,
          encodeFunctionData({
            abi: ABI,
            functionName: 'exchange',
            args: [1n, 0n, inputs[i], minDy, holder],
          }),
          stage,
          row.checkpoint.block.number,
        ),
      )
      route[`${i ? 'usdc' : 'usdt'}Leg`] = {
        crvUsdInputRaw: String(inputs[i]),
        atExecutionGetDyRaw: String(quoted),
        minOutputRaw: String(minDy),
      }
    }
    route.after = await balances(session, identity, holder)
    const usdt = raw(route.after.usdtRaw) - raw(route.afterWithdraw.usdtRaw)
    const usdc = raw(route.after.usdcRaw) - raw(route.afterWithdraw.usdcRaw)
    if (usdt < 0n || usdc < 0n || raw(route.after.crvUsdRaw) !== raw(route.before.crvUsdRaw))
      throw new Error('Route token conservation mismatch')
    for (const [delta, leg] of [
      [usdt, route.usdtLeg],
      [usdc, route.usdcLeg],
    ]) {
      if (leg && (delta <= 0n || delta < raw(leg.minOutputRaw)))
        throw new Error('Executed output below predeclared minimum')
      if (!leg && delta !== 0n) throw new Error('Unexpected output on unused route')
    }
    route.output = {
      usdtRaw: String(usdt),
      usdcRaw: String(usdc),
      usdTotal: null,
      valuation: 'not_pinned',
    }
    route.deployedAbiBehavior = 'observed_via_fork_transaction_and_token_deltas'
    route.status = 'fork_executed'
    await rpc(session, 'anvil_stopImpersonatingAccount', [holder])
    return { route, nextSnapshot }
  } catch (error) {
    route.failedStage = stage
    route.failure = error?.receipt
      ? { code: 'transaction_reverted', receipt: error.receipt }
      : { code: 'stage_unavailable' }
    try {
      await rpc(session, 'anvil_stopImpersonatingAccount', [holder])
    } catch {
      /* fork cleanup only */
    }
    return { route, nextSnapshot: null }
  }
}

export async function execute({
  sources,
  adapter,
  rpcUrl,
  stat = statfsSync,
  out = OUT,
  now = () => new Date(),
}) {
  diskGuard(out, stat)
  const { row, target, plan, refs } = sources
  const identity = sourceIdentity()
  if (JSON.stringify(row.checkpoint.source) !== JSON.stringify(identity))
    throw new Error('Source identity mismatch')
  const capturedAtUtc = now().toISOString()
  const routes = []
  let failureStage = null
  let session
  try {
    session = await adapter.start({ rpcUrl, blockNumber: row.checkpoint.block.number })
  } catch {
    failureStage = 'fork_start'
  }
  if (session) {
    try {
      await verifyFork(session, row, target, identity, plan.holder)
      let snapshot = await rpc(session, 'evm_snapshot')
      for (const shareBps of plan.sharesBps) {
        const result = await oneRoute(session, {
          identity,
          row,
          target,
          plan,
          shareBps,
          baselineSnapshot: snapshot,
        })
        routes.push(result.route)
        if (result.nextSnapshot === null) {
          // A failed stage may leave a mutated fork. Refuse all remaining splits.
          break
        }
        snapshot = result.nextSnapshot
      }
    } catch {
      failureStage = 'fork_verification_or_snapshot'
    } finally {
      await session.stop()
    }
  }
  const result = seal({
    study: STUDY,
    kind: 'counterfactual-stateful-route',
    source: identity,
    block: row.checkpoint.block,
    refs,
    plan,
    capturedAtUtc,
    completedAtUtc: now().toISOString(),
    routes,
    failureStage,
    status:
      routes.length === plan.sharesBps.length &&
      routes.every((r) => r.status === 'fork_executed') &&
      !failureStage
        ? 'all_routes_executed'
        : 'partial_or_unavailable',
    deployedAbiAttestation: 'not_independently_source_attested',
    caveat,
  })
  saveResult({ result, out, stat })
  return result
}

export function saveResult({ result, out = OUT, stat = statfsSync }) {
  if (result.sha256 !== sha(JSON.stringify(unsigned(result))))
    throw new Error('Result seal mismatch')
  const bytes = `${JSON.stringify(result)}\n`
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const path = join(
    out,
    `${String(result.block.number).padStart(12, '0')}-${result.block.hash.slice(2)}-${result.plan.sha256}.json`,
  )
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(tmp, path)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
  return path
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  )
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
export const anvilAdapter = {
  async start({ rpcUrl, blockNumber }) {
    if (!/^https?:\/\/[^,]+$/.test(rpcUrl || '')) throw new Error('One archive RPC URL required')
    const port = await freePort()
    const child = spawn(
      'anvil',
      [
        '--fork-url',
        rpcUrl,
        '--fork-block-number',
        String(blockNumber),
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--silent',
      ],
      { stdio: 'ignore' },
    )
    let spawnFailed = false
    child.on('error', () => {
      spawnFailed = true
    })
    const endpoint = `http://127.0.0.1:${port}`
    let nextId = 1
    const request = async (method, params = []) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(30_000),
      })
      const json = await response.json()
      if (!response.ok || json.error) throw new Error('Fork RPC unavailable')
      return json.result
    }
    try {
      let ready = false
      for (let i = 0; i < 100; i++) {
        if (spawnFailed) throw new Error('Anvil could not start')
        if (child.exitCode !== null) throw new Error('Anvil exited')
        try {
          await request('eth_chainId')
          ready = true
          break
        } catch {
          await new Promise((done) => setTimeout(done, 100))
        }
      }
      if (!ready) throw new Error('Anvil fork startup unavailable')
      return {
        request,
        stop: async () => {
          child.kill('SIGTERM')
        },
      }
    } catch (error) {
      child.kill('SIGTERM')
      throw error
    }
  },
}

function args(argv) {
  const allowed = [
    '--quote',
    '--quote-sha256',
    '--target',
    '--target-sha256',
    '--plan',
    '--plan-sha256',
    '--block',
    '--hash',
    '--out',
    '--run',
  ]
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!allowed.includes(key) || key in options) throw new Error('Invalid option')
    options[key] = key === '--run' ? true : argv[++i]
    if (!options[key]) throw new Error('Missing option value')
  }
  return options
}
async function main() {
  const opt = args(process.argv.slice(2))
  if (!opt['--run'])
    return console.log(
      JSON.stringify({
        mode: 'dry',
        study: STUDY,
        reserveBytes: RESERVE_BYTES,
        requirement: 'sealed v2 quote + target attestation + pre-B route plan; --run is explicit',
      }),
    )
  const out = opt['--out'] ? resolve(opt['--out']) : OUT
  diskGuard(out) // before source reads or anvil/RPC
  const sources = loadSources({
    quotePath: opt['--quote'],
    quoteSha256: opt['--quote-sha256'],
    targetPath: opt['--target'],
    targetSha256: opt['--target-sha256'],
    planPath: opt['--plan'],
    planSha256: opt['--plan-sha256'],
  })
  if (
    String(sources.row.checkpoint.block.number) !== opt['--block'] ||
    sources.row.checkpoint.block.hash !== opt['--hash']
  )
    throw new Error('Requested B/hash differs')
  const rpcUrl = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  const result = await execute({ sources, adapter: anvilAdapter, rpcUrl, out })
  console.log(
    JSON.stringify({
      status: result.status,
      block: result.block.number,
      routes: result.routes.length,
    }),
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(JSON.stringify({ status: 'unavailable', study: STUDY }))
    process.exitCode = 1
  })
