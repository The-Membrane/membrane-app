// Local prospective same-holder Fluid fToken callability observations.
// A successful eth_call is not a mined transfer or a future forecast.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiItem,
  toEventHash,
} from 'viem'
import { configuredClients, ROUTES } from './carry-fluid-ftoken-payout.mjs'

// Both the native tick wrapper and Next's local API run from the repo root.
// Webpack treats new URL(relative, import.meta.url) as a module asset and
// cannot bundle a directory reference here.
const ROOT = resolve(process.cwd())
export const STORE = join(ROOT, 'data/research/venue-signals/local-fluid-ftoken-holder-v1')
export const HORIZONS_HOURS = [1, 4, 24, 48, 168]
export const SCAN_WINDOWS = 64
const DEADLINE_HOURS = 2
const MAX_BYTES = 512 * 1024
const RESERVE = 1024n ** 3n
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const LIQUIDITY = '0x52aa899454998be5b000ad077a46bbe360f4e497'
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function getData() view returns (address liquidity,address factory,address rewards,address permit2,address rebalancer,bool rewardsActive,uint256 liquidityBalance,uint256 liquidityExchangePrice,uint256 tokenExchangePrice)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const TRANSFER_TOPIC = toEventHash(TRANSFER).toLowerCase()
const sha = (value) => createHash('sha256').update(value).digest('hex')
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const check = (ok, code) => {
  if (!ok) throw Error(`fluid_holder_${code}`)
}
const utc = (ms) => new Date(ms).toISOString()
const qName = (i) =>
  ['holder_1pct', 'holder_10pct', 'holder_25pct', 'holder_50pct', 'holder_100pct'][i]
const pathFor = (kind, routeIndex) => join(STORE, kind, String(routeIndex))
const nameFor = (n) => `${String(n).padStart(8, '0')}.json`
const stripped = ({ sha256: _seal, ...body }) => body

function reserve(path, bytes) {
  let parent = path
  while (!existsSync(parent)) parent = dirname(parent)
  const disk = statfsSync(parent, { bigint: true })
  check(disk.bavail * disk.bsize - BigInt(bytes) >= RESERVE, 'disk_reserve')
}
export function readChain(dir) {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).sort()
  check(
    names.every((name, i) => name === nameFor(i + 1)),
    'ledger_filename',
  )
  const rows = []
  for (const name of names) {
    const fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      check(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, 'ledger_file')
      const body = readFileSync(fd, 'utf8')
      const after = fstatSync(fd)
      check(
        Buffer.byteLength(body) === stat.size &&
          after.size === stat.size &&
          after.mtimeMs === stat.mtimeMs,
        'ledger_changed',
      )
      const row = JSON.parse(body)
      check(
        body === `${JSON.stringify(row)}\n` &&
          row.sequence === rows.length + 1 &&
          row.previousSha256 === (rows.at(-1)?.sha256 ?? null) &&
          SHA.test(row.sha256) &&
          sha(JSON.stringify(stripped(row))) === row.sha256,
        'ledger_chain',
      )
      rows.push(row)
    } finally {
      closeSync(fd)
    }
  }
  return rows
}
export function appendChain(dir, body, validate) {
  const prior = readChain(dir)
  const record = {
    ...body,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  }
  if (validate) validate(record, prior)
  const sealed = { ...record, sha256: sha(JSON.stringify(record)) }
  const bytes = `${JSON.stringify(sealed)}\n`
  check(Buffer.byteLength(bytes) <= MAX_BYTES, 'record_oversize')
  reserve(dir, Buffer.byteLength(bytes))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, nameFor(sealed.sequence))
  const temp = `${file}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temp, file)
    const dfd = openSync(dir, 'r')
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
  return sealed
}

function routeAt(index) {
  check(Number.isInteger(index) && index >= 0 && index < ROUTES.length, 'route_invalid')
  return ROUTES[index]
}
function originNames(origins) {
  return origins.map((x) => x.origin)
}
function finalizedHeaderValid(header) {
  return (
    header &&
    typeof header.number === 'bigint' &&
    HASH.test(String(header.hash).toLowerCase()) &&
    typeof header.timestamp === 'bigint'
  )
}
async function sharedFinalized(origins) {
  check(
    origins?.length === 2 &&
      origins[0].origin === 'eth-mainnet.g.alchemy.com' &&
      origins[1].origin === 'rpc.ankr.com',
    'origins_invalid',
  )
  const finals = await Promise.all(origins.map((x) => x.client.getBlock({ blockTag: 'finalized' })))
  check(finals.every(finalizedHeaderValid), 'finality_unavailable')
  const number = finals[0].number < finals[1].number ? finals[0].number : finals[1].number
  const headers = await Promise.all(origins.map((x) => x.client.getBlock({ blockNumber: number })))
  check(
    headers.every(
      (h) =>
        finalizedHeaderValid(h) &&
        h.number === number &&
        eq(h.hash, headers[0].hash) &&
        h.timestamp === headers[0].timestamp,
    ),
    'header_disagreement',
  )
  return {
    number,
    hash: String(headers[0].hash).toLowerCase(),
    timestamp: Number(headers[0].timestamp),
    atUtc: utc(Number(headers[0].timestamp) * 1000),
    origins: originNames(origins),
  }
}
async function assertHeader(origins, header) {
  const headers = await Promise.all(
    origins.map((x) => x.client.getBlock({ blockNumber: header.number })),
  )
  check(
    headers.every(
      (h) =>
        h.number === header.number &&
        eq(h.hash, header.hash) &&
        Number(h.timestamp) === header.timestamp,
    ),
    'header_changed',
  )
}
async function identityAt(origins, route, header) {
  const observed = await Promise.all(
    origins.map(async (x) => {
      const c = x.client,
        b = header.number,
        v = route.vault
      const [
        asset,
        data,
        vaultCode,
        assetCode,
        liquidityCode,
        beaconSlot,
        implementationSlot,
        assetDecimals,
        shareDecimals,
      ] = await Promise.all([
        c.readContract({ address: v, abi: ABI, functionName: 'asset', blockNumber: b }),
        c.readContract({ address: v, abi: ABI, functionName: 'getData', blockNumber: b }),
        c.getCode({ address: v, blockNumber: b }),
        c.getCode({ address: route.asset, blockNumber: b }),
        c.getCode({ address: LIQUIDITY, blockNumber: b }),
        c.getStorageAt({ address: v, slot: BEACON_SLOT, blockNumber: b }),
        c.getStorageAt({ address: v, slot: IMPLEMENTATION_SLOT, blockNumber: b }),
        c.readContract({
          address: route.asset,
          abi: ABI,
          functionName: 'decimals',
          blockNumber: b,
        }),
        c.readContract({ address: v, abi: ABI, functionName: 'decimals', blockNumber: b }),
      ])
      check(
        eq(asset, route.asset) &&
          eq(data[0], LIQUIDITY) &&
          vaultCode &&
          vaultCode !== '0x' &&
          assetCode &&
          assetCode !== '0x' &&
          liquidityCode &&
          liquidityCode !== '0x',
        'identity_invalid',
      )
      check(
        beaconSlot &&
          implementationSlot &&
          eq(`0x${beaconSlot.slice(-40)}`, ZERO) &&
          eq(`0x${implementationSlot.slice(-40)}`, ZERO),
        'implementation_changed',
      )
      const expectedDecimals = route.asset === '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f' ? 18 : 6
      check(
        Number(assetDecimals) === expectedDecimals &&
          Number(shareDecimals) >= 6 &&
          Number(shareDecimals) <= 18,
        'decimals_invalid',
      )
      return {
        vault: v,
        asset: route.asset,
        liquidity: LIQUIDITY,
        implementation: v,
        runtimeHash: keccak256(vaultCode),
        liquidityHash: keccak256(liquidityCode),
        assetDecimals: Number(assetDecimals),
        shareDecimals: Number(shareDecimals),
      }
    }),
  )
  check(JSON.stringify(observed[0]) === JSON.stringify(observed[1]), 'identity_disagreement')
  await assertHeader(origins, header)
  return observed[0]
}

function sameMeasurement(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}
function evmRevert(error) {
  const name = String(error?.name || '')
  const message = String(error?.shortMessage || error?.message || '').toLowerCase()
  return (
    name === 'ContractFunctionRevertedError' ||
    (/execution reverted|reverted with/.test(message) &&
      !/out of gas|gas limit|rate limit/.test(message)) ||
    (error?.cause && error.cause !== error && evmRevert(error.cause))
  )
}

async function assay(origins, route, header, holder, amount) {
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'withdraw',
    args: [amount, holder, holder],
  })
  const pair = await Promise.all(
    origins.map(async (x) => {
      try {
        const result = await x.client.call({
          account: holder,
          to: route.vault,
          data,
          blockNumber: header.number,
          gas: 20_000_000n,
        })
        check(result.data, 'call_result_missing')
        const shares = decodeFunctionResult({
          abi: ABI,
          functionName: 'withdraw',
          data: result.data,
        })
        check(typeof shares === 'bigint' && shares > 0n, 'burn_result_invalid')
        return { status: 'success', sharesBurnedRaw: shares.toString() }
      } catch (error) {
        if (evmRevert(error)) return { status: 'evm_revert', sharesBurnedRaw: null }
        throw error
      }
    }),
  )
  check(sameMeasurement(pair[0], pair[1]), 'assay_disagreement')
  return {
    ...pair[0],
    originWitnesses: origins.map((origin, index) => ({
      origin: origin.origin,
      result: pair[index],
    })),
  }
}
export async function holderPosition(origins, route, header, holder) {
  const pair = await Promise.all(
    origins.map(async (x) => {
      const c = x.client,
        b = header.number
      const code = await c.getCode({ address: holder, blockNumber: b })
      // viem may represent an EOA's empty runtime as undefined or 0x.
      if (code && code !== '0x') return null
      const shares = await c.readContract({
        address: route.vault,
        abi: ABI,
        functionName: 'balanceOf',
        args: [holder],
        blockNumber: b,
      })
      if (typeof shares !== 'bigint' || shares <= 0n) return null
      const claim = await c.readContract({
        address: route.vault,
        abi: ABI,
        functionName: 'previewRedeem',
        args: [shares],
        blockNumber: b,
      })
      if (typeof claim !== 'bigint' || claim <= 0n) return null
      let maxWithdraw
      try {
        maxWithdraw = await c.readContract({
          address: route.vault,
          abi: ABI,
          functionName: 'maxWithdraw',
          args: [holder],
          blockNumber: b,
        })
      } catch (error) {
        if (!evmRevert(error)) throw error
        maxWithdraw = null
      }
      check(maxWithdraw === null || typeof maxWithdraw === 'bigint', 'max_withdraw_invalid')
      return {
        sharesRaw: shares.toString(),
        claimAssetsRaw: claim.toString(),
        maxWithdrawRaw: maxWithdraw?.toString() ?? null,
      }
    }),
  )
  check(sameMeasurement(pair[0], pair[1]), 'holder_disagreement')
  return pair[0]
}

export async function holderEntitlement(origins, route, header, holder, amount, position) {
  if (!position)
    return { status: 'holder_ineligible', reason: 'no_current_shares', requiredSharesRaw: null }
  const pair = await Promise.all(
    origins.map(async (x) => {
      try {
        const required = await x.client.readContract({
          address: route.vault,
          abi: ABI,
          functionName: 'previewWithdraw',
          args: [amount],
          blockNumber: header.number,
        })
        check(typeof required === 'bigint' && required > 0n, 'preview_withdraw_invalid')
        return required.toString()
      } catch (error) {
        if (evmRevert(error)) return null
        throw error
      }
    }),
  )
  check(sameMeasurement(pair[0], pair[1]), 'entitlement_disagreement')
  if (pair[0] === null)
    return {
      status: 'entitlement_unassessed',
      reason: 'preview_withdraw_reverted',
      requiredSharesRaw: null,
    }
  if (BigInt(position.sharesRaw) < BigInt(pair[0]) || BigInt(position.claimAssetsRaw) < amount)
    return {
      status: 'holder_ineligible',
      reason: 'shares_below_fixed_amount',
      requiredSharesRaw: pair[0],
    }
  return { status: 'covered', reason: null, requiredSharesRaw: pair[0] }
}

async function findHolder(origins, route, header, excluded, scanWindow = 0, scanOffset = 0) {
  const head = header.number
  const filter = (start, end) => ({
    address: route.vault,
    topics: [TRANSFER_TOPIC],
    fromBlock: `0x${start.toString(16)}`,
    toBlock: `0x${end.toString(16)}`,
  })
  const normalize = (arr) =>
    arr
      .map((l) => ({
        address: String(l.address).toLowerCase(),
        topics: l.topics.map((t) => String(t).toLowerCase()),
        data: String(l.data).toLowerCase(),
        tx: String(l.transactionHash).toLowerCase(),
        blockHash: String(l.blockHash).toLowerCase(),
        index: Number(l.logIndex),
        block: Number(BigInt(l.blockNumber)),
      }))
      .sort((a, b) => a.block - b.block || a.index - b.index)
  const screened = new Set()
  const considered = new Set()
  // One 4,096-block window per native tick. The attempt ledger rotates through
  // 64 windows, bounding each run while eventually screening 262,144 blocks.
  // Broad Ankr logs nominate holders only; the chosen one-block slice and
  // finalized EOA position are independently corroborated on two origins.
  check(
    Number.isInteger(scanWindow) && scanWindow >= 0 && scanWindow < SCAN_WINDOWS,
    'scan_window_invalid',
  )
  check(
    Number.isInteger(scanOffset) && scanOffset >= 0 && scanOffset <= 8192,
    'scan_offset_invalid',
  )
  {
    const to = head - BigInt(scanWindow) * 4096n
    if (to < 0n) return null
    const from = to >= 4095n ? to - 4095n : 0n
    const proposed = normalize(
      await origins[1].client.request({ method: 'eth_getLogs', params: [filter(from, to)] }),
    )
    check(proposed.length <= 4096, 'candidate_log_budget')
    for (const log of proposed.reverse()) {
      let decoded
      try {
        decoded = decodeEventLog({
          abi: [TRANSFER],
          data: log.data,
          topics: log.topics,
          strict: true,
        }).args
      } catch {
        continue
      }
      for (const [role, candidate] of [
        ['recipient', decoded.to],
        ['sender', decoded.from],
      ]) {
        const holder = String(candidate).toLowerCase()
        if (
          !ADDRESS.test(holder) ||
          holder === ZERO ||
          excluded.has(holder) ||
          considered.has(holder)
        )
          continue
        const candidateIndex = considered.size
        considered.add(holder)
        if (candidateIndex < scanOffset) continue
        if (screened.size >= 64)
          return { status: 'scan_budget_exhausted', nextOffset: scanOffset + 64 }
        screened.add(holder)
        const position = await holderPosition(origins, route, header, holder)
        if (!position) continue
        const selectedBlock = BigInt(log.block)
        const witnessed = await Promise.all(
          origins.map((x) =>
            x.client.request({
              method: 'eth_getLogs',
              params: [filter(selectedBlock, selectedBlock)],
            }),
          ),
        )
        const left = normalize(witnessed[0]),
          right = normalize(witnessed[1])
        check(
          sameMeasurement(left, right) && left.some((row) => sameMeasurement(row, log)),
          'selected_candidate_log_disagree',
        )
        const selectedLog = left.find((row) => sameMeasurement(row, log))
        const [selectedHeaders, minedReceipts] = await Promise.all([
          Promise.all(origins.map((x) => x.client.getBlock({ blockNumber: selectedBlock }))),
          Promise.all(origins.map((x) => x.client.getTransactionReceipt({ hash: log.tx }))),
        ])
        check(
          selectedHeaders.every(
            (b) =>
              finalizedHeaderValid(b) && b.number === selectedBlock && eq(b.hash, log.blockHash),
          ),
          'selected_candidate_header_disagree',
        )
        const receipts = minedReceipts.map((receipt) => ({
          status: receipt.status,
          transactionHash: String(receipt.transactionHash).toLowerCase(),
          blockHash: String(receipt.blockHash).toLowerCase(),
          blockNumber: Number(receipt.blockNumber),
          logs: normalize(receipt.logs),
        }))
        check(
          sameMeasurement(receipts[0], receipts[1]) &&
            receipts.every(
              (receipt) =>
                receipt.status === 'success' &&
                receipt.transactionHash === log.tx &&
                receipt.blockHash === log.blockHash &&
                receipt.blockNumber === log.block &&
                receipt.logs.some((row) => sameMeasurement(row, selectedLog)) &&
                receipt.logs.every(
                  (row) =>
                    row.tx === log.tx && row.blockHash === log.blockHash && row.block === log.block,
                ),
            ),
          'selected_candidate_receipt_disagree',
        )
        return {
          holder,
          position,
          selection: {
            fromBlock: Number(from),
            toBlock: Number(to),
            selectedBlock: log.block,
            transferTx: log.tx,
            transferLogIndex: log.index,
            transferRole: role,
            broadDiscoveryOrigin: origins[1].origin,
            selectedSliceWitnesses: header.origins,
            witnesses: origins.map((origin, index) => ({
              origin: origin.origin,
              selectedBlockHash: String(selectedHeaders[index].hash).toLowerCase(),
              rawSelectedLog:
                index === 0 ? selectedLog : right.find((row) => sameMeasurement(row, log)),
              receipt: receipts[index],
            })),
          },
        }
      }
    }
  }
  return null
}

export function qLadder(claim) {
  const claimRaw = BigInt(claim)
  const divisors = [100n, 10n, 4n, 2n, 1n]
  const seen = new Set()
  return divisors
    .map((d, i) => ({ label: qName(i), assetsRaw: (claimRaw / d).toString() }))
    .filter((x) => BigInt(x.assetsRaw) > 0n && !seen.has(x.assetsRaw) && seen.add(x.assetsRaw))
}
function validAssay(assayResult, origins) {
  const result = {
    status: assayResult?.status,
    sharesBurnedRaw: assayResult?.sharesBurnedRaw,
  }
  return (
    ['success', 'evm_revert'].includes(result.status) &&
    (result.status === 'success'
      ? /^[1-9][0-9]*$/.test(result.sharesBurnedRaw ?? '')
      : result.sharesBurnedRaw === null) &&
    assayResult.originWitnesses?.length === 2 &&
    assayResult.originWitnesses.every(
      (witness, index) =>
        witness.origin === origins[index] && sameMeasurement(witness.result, result),
    )
  )
}
function validEntitlement(entitlement, position, assetsRaw) {
  const amount = BigInt(assetsRaw)
  if (entitlement?.status === 'covered')
    return (
      position !== null &&
      /^[1-9][0-9]*$/.test(entitlement.requiredSharesRaw ?? '') &&
      BigInt(position.sharesRaw) >= BigInt(entitlement.requiredSharesRaw) &&
      BigInt(position.claimAssetsRaw) >= amount
    )
  if (entitlement?.status === 'holder_ineligible') {
    if (entitlement.reason === 'no_current_shares')
      return position === null && entitlement.requiredSharesRaw === null
    return (
      entitlement.reason === 'shares_below_fixed_amount' &&
      position !== null &&
      /^[1-9][0-9]*$/.test(entitlement.requiredSharesRaw ?? '') &&
      (BigInt(position.sharesRaw) < BigInt(entitlement.requiredSharesRaw) ||
        BigInt(position.claimAssetsRaw) < amount)
    )
  }
  return (
    entitlement?.status === 'entitlement_unassessed' &&
    entitlement.reason === 'preview_withdraw_reverted' &&
    position !== null &&
    entitlement.requiredSharesRaw === null
  )
}
export function validSelection(selection, route, holder, baseline) {
  if (
    !selection ||
    !Number.isSafeInteger(selection.fromBlock) ||
    !Number.isSafeInteger(selection.toBlock) ||
    !Number.isSafeInteger(selection.selectedBlock) ||
    selection.selectedBlock < selection.fromBlock ||
    selection.selectedBlock > selection.toBlock ||
    selection.selectedBlock > baseline.number ||
    !HASH.test(selection.transferTx ?? '') ||
    !Number.isSafeInteger(selection.transferLogIndex) ||
    !['recipient', 'sender'].includes(selection.transferRole) ||
    selection.witnesses?.length !== 2
  )
    return false
  const [a, b] = selection.witnesses
  if (
    a.origin !== 'eth-mainnet.g.alchemy.com' ||
    b.origin !== 'rpc.ankr.com' ||
    !sameMeasurement(a.rawSelectedLog, b.rawSelectedLog) ||
    !sameMeasurement(a.receipt, b.receipt)
  )
    return false
  const log = a.rawSelectedLog
  if (
    !eq(log?.address, route.vault) ||
    !eq(log?.topics?.[0], TRANSFER_TOPIC) ||
    log?.tx !== selection.transferTx ||
    log?.index !== selection.transferLogIndex ||
    log?.block !== selection.selectedBlock ||
    !HASH.test(log?.blockHash ?? '')
  )
    return false
  try {
    const args = decodeEventLog({
      abi: [TRANSFER],
      data: log.data,
      topics: log.topics,
      strict: true,
    }).args
    if (!eq(selection.transferRole === 'recipient' ? args.to : args.from, holder)) return false
  } catch {
    return false
  }
  return [a, b].every(
    (witness) =>
      witness.selectedBlockHash === log.blockHash &&
      sameMeasurement(witness.rawSelectedLog, log) &&
      witness.receipt?.status === 'success' &&
      witness.receipt.transactionHash === log.tx &&
      witness.receipt.blockHash === log.blockHash &&
      witness.receipt.blockNumber === log.block &&
      Array.isArray(witness.receipt.logs) &&
      witness.receipt.logs.some((row) => sameMeasurement(row, log)) &&
      witness.receipt.logs.every(
        (row) => row.tx === log.tx && row.blockHash === log.blockHash && row.block === log.block,
      ),
  )
}
export function verifyIssues(routeIndex, dir = pathFor('issues', routeIndex)) {
  const route = routeAt(routeIndex),
    issues = readChain(dir)
  for (const issue of issues) {
    check(
      issue.study === 'fluid_ftoken_holder_issue_v1' &&
        issue.routeIndex === routeIndex &&
        issue.routeKey === route.key &&
        issue.vault === route.vault &&
        issue.asset === route.asset &&
        ADDRESS.test(issue.holder) &&
        HASH.test(issue.baseline?.hash) &&
        sameMeasurement(issue.baseline?.origins, ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']) &&
        Number.isSafeInteger(issue.baseline.number) &&
        Number.isSafeInteger(issue.baseline.timestamp) &&
        issue.baseline.atUtc === utc(issue.baseline.timestamp * 1000) &&
        Date.parse(issue.issuedAtUtc) >= issue.baseline.timestamp * 1000 - 120_000 &&
        Date.parse(issue.issuedAtUtc) - issue.baseline.timestamp * 1000 <= 3_600_000 &&
        issue.identity?.vault === route.vault &&
        issue.identity?.asset === route.asset &&
        issue.identity?.liquidity === LIQUIDITY &&
        issue.identity?.implementation === route.vault &&
        HASH.test(issue.identity?.runtimeHash ?? '') &&
        HASH.test(issue.identity?.liquidityHash ?? '') &&
        /^[1-9][0-9]*$/.test(issue.position?.sharesRaw ?? '') &&
        /^[1-9][0-9]*$/.test(issue.position?.claimAssetsRaw ?? '') &&
        validSelection(issue.selection, route, issue.holder, issue.baseline) &&
        issue.selection?.broadDiscoveryOrigin === 'rpc.ankr.com' &&
        sameMeasurement(issue.selection?.selectedSliceWitnesses, issue.baseline.origins) &&
        Array.isArray(issue.cases) &&
        issue.cases.length > 0 &&
        issue.cases.length <= 5 &&
        issue.targets?.length === 5,
      'issue_invalid',
    )
    check(
      issue.targets.every(
        (t, i) =>
          t.horizonHours === HORIZONS_HOURS[i] &&
          t.targetAtUtc === utc(Date.parse(issue.issuedAtUtc) + t.horizonHours * 3_600_000) &&
          t.deadlineUtc ===
            utc(Date.parse(issue.issuedAtUtc) + (t.horizonHours + DEADLINE_HOURS) * 3_600_000),
      ),
      'issue_targets_invalid',
    )
    check(
      sameMeasurement(
        issue.cases.map((c) => ({ label: c.label, assetsRaw: c.assetsRaw })),
        qLadder(issue.position.claimAssetsRaw),
      ) && issue.cases.every((c) => validAssay(c.baseline, issue.baseline.origins)),
      'issue_case_invalid',
    )
  }
  return issues
}
export function verifyScores(
  routeIndex,
  issues = verifyIssues(routeIndex),
  dir = pathFor('scores', routeIndex),
) {
  const route = routeAt(routeIndex),
    scores = readChain(dir)
  const seen = new Set()
  for (const score of scores) {
    const issue = issues[score.issueSequence - 1]
    check(
      issue &&
        score.study === 'fluid_ftoken_holder_score_v1' &&
        score.routeIndex === routeIndex &&
        score.routeKey === route.key &&
        score.issueSha256 === issue.sha256 &&
        HORIZONS_HOURS.includes(score.horizonHours) &&
        !seen.has(`${score.issueSequence}:${score.horizonHours}`),
      'score_invalid',
    )
    seen.add(`${score.issueSequence}:${score.horizonHours}`)
    const target = issue.targets.find((t) => t.horizonHours === score.horizonHours)
    check(
      score.targetAtUtc === target.targetAtUtc &&
        ['measured', 'capture_window_missed', 'identity_changed'].includes(score.status),
      'score_target_invalid',
    )
    if (score.status === 'measured')
      check(
        score.block?.hash &&
          score.block.timestamp * 1000 >= Date.parse(target.targetAtUtc) &&
          score.block.timestamp * 1000 <= Date.parse(target.deadlineUtc) &&
          Date.parse(score.scoredAtUtc) <= Date.parse(target.deadlineUtc) &&
          score.identity?.runtimeHash === issue.identity.runtimeHash &&
          score.identity?.liquidityHash === issue.identity.liquidityHash &&
          sameMeasurement(score.block.origins, issue.baseline.origins) &&
          score.cases?.length === issue.cases.length &&
          (score.positionAtTarget === null ||
            (/^[1-9][0-9]*$/.test(score.positionAtTarget?.sharesRaw ?? '') &&
              /^[1-9][0-9]*$/.test(score.positionAtTarget?.claimAssetsRaw ?? ''))) &&
          score.cases.every(
            (c, i) =>
              c.assetsRaw === issue.cases[i].assetsRaw &&
              c.label === issue.cases[i].label &&
              validEntitlement(c.entitlement, score.positionAtTarget, c.assetsRaw) &&
              (c.entitlement.status === 'covered'
                ? validAssay(c.outcome, issue.baseline.origins)
                : c.outcome === null),
          ),
        'score_measurement_invalid',
      )
    else if (score.status === 'identity_changed')
      check(
        score.block?.hash &&
          score.identity?.runtimeHash &&
          score.identity?.liquidityHash &&
          (score.identity.runtimeHash !== issue.identity.runtimeHash ||
            score.identity.liquidityHash !== issue.identity.liquidityHash) &&
          score.cases === null &&
          sameMeasurement(score.block.origins, issue.baseline.origins),
        'score_identity_censor_invalid',
      )
    else
      check(
        score.cases === null &&
          score.block === null &&
          sameMeasurement(score.finalizedDeadlineWitness?.origins, issue.baseline.origins) &&
          score.finalizedDeadlineWitness?.timestamp * 1000 > Date.parse(target.deadlineUtc),
        'score_censor_invalid',
      )
  }
  return scores
}

export async function issueRoute(
  routeIndex,
  { origins = configuredClients(), now = Date.now, scanWindow = 0, scanOffset = 0 } = {},
) {
  const route = routeAt(routeIndex),
    issues = verifyIssues(routeIndex)
  const header = await sharedFinalized(origins)
  const identity = await identityAt(origins, route, header)
  const found = await findHolder(
    origins,
    route,
    header,
    new Set(issues.map((i) => i.holder)),
    scanWindow,
    scanOffset,
  )
  if (!found) return { status: 'no_fresh_holder', routeKey: route.key, scanWindow, scanOffset }
  if (found.status === 'scan_budget_exhausted')
    return {
      status: 'scan_budget_exhausted',
      routeKey: route.key,
      scanWindow,
      nextOffset: found.nextOffset,
    }
  const cases = []
  for (const q of qLadder(found.position.claimAssetsRaw))
    cases.push({
      ...q,
      baseline: await assay(origins, route, header, found.holder, BigInt(q.assetsRaw)),
    })
  await assertHeader(origins, header)
  const issuedAtUtc = utc(now())
  const targets = HORIZONS_HOURS.map((h) => ({
    horizonHours: h,
    targetAtUtc: utc(Date.parse(issuedAtUtc) + h * 3_600_000),
    deadlineUtc: utc(Date.parse(issuedAtUtc) + (h + DEADLINE_HOURS) * 3_600_000),
  }))
  const row = appendChain(
    pathFor('issues', routeIndex),
    {
      study: 'fluid_ftoken_holder_issue_v1',
      routeIndex,
      routeKey: route.key,
      vault: route.vault,
      asset: route.asset,
      holder: found.holder,
      issuedAtUtc,
      baseline: {
        number: Number(header.number),
        hash: header.hash,
        timestamp: header.timestamp,
        atUtc: header.atUtc,
        origins: header.origins,
      },
      identity,
      selection: found.selection,
      position: found.position,
      cases,
      targets,
      interpretation: 'read_only_same_holder_callability_not_mined_delivery',
    },
    (r) =>
      check(
        r.cases.length > 0 &&
          r.holder === found.holder &&
          validSelection(r.selection, route, r.holder, r.baseline),
        'issue_build_invalid',
      ),
  )
  return {
    status: 'issued',
    routeKey: route.key,
    sequence: row.sequence,
    sha256: row.sha256,
    cases: row.cases.length,
  }
}

async function firstFinalizedAfter(origins, baseline, head, targetMs) {
  if (head.timestamp * 1000 < targetMs) return null
  let lo = BigInt(baseline.number) + 1n,
    hi = head.number
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const block = await origins[0].client.getBlock({ blockNumber: mid })
    check(finalizedHeaderValid(block), 'search_header_invalid')
    if (Number(block.timestamp) * 1000 >= targetMs) hi = mid
    else lo = mid + 1n
  }
  const blocks = await Promise.all(origins.map((x) => x.client.getBlock({ blockNumber: lo })))
  check(
    blocks.every(
      (b) =>
        finalizedHeaderValid(b) &&
        b.number === lo &&
        eq(b.hash, blocks[0].hash) &&
        b.timestamp === blocks[0].timestamp,
    ),
    'target_header_disagreement',
  )
  const previous = await Promise.all(
    origins.map((x) => x.client.getBlock({ blockNumber: lo - 1n })),
  )
  check(
    previous.every(
      (b) =>
        finalizedHeaderValid(b) &&
        b.number === lo - 1n &&
        eq(b.hash, blocks[0].parentHash) &&
        Number(b.timestamp) * 1000 < targetMs,
    ),
    'target_boundary_invalid',
  )
  return {
    number: lo,
    hash: String(blocks[0].hash).toLowerCase(),
    timestamp: Number(blocks[0].timestamp),
    atUtc: utc(Number(blocks[0].timestamp) * 1000),
    origins: originNames(origins),
  }
}
/** Protect still-open windows before sealing older missed targets. */
export function selectDueFluidHolderTargets(issues, scores, nowMs, maxScores = 8) {
  const completed = new Set(scores.map((score) => `${score.issueSequence}:${score.horizonHours}`))
  return issues
    .flatMap((issue) =>
      issue.targets
        .filter(
          (t) =>
            !completed.has(`${issue.sequence}:${t.horizonHours}`) &&
            Date.parse(t.targetAtUtc) <= nowMs,
        )
        .map((t) => ({ issue, target: t })),
    )
    .sort(
      (a, b) =>
        Number(nowMs > Date.parse(a.target.deadlineUtc)) -
          Number(nowMs > Date.parse(b.target.deadlineUtc)) ||
        Date.parse(a.target.deadlineUtc) - Date.parse(b.target.deadlineUtc) ||
        Date.parse(a.target.targetAtUtc) - Date.parse(b.target.targetAtUtc) ||
        a.issue.sequence - b.issue.sequence,
    )
    .slice(0, maxScores)
}

export async function scoreDue(
  routeIndex,
  { origins = configuredClients(), now = Date.now, maxScores = 8 } = {},
) {
  const route = routeAt(routeIndex),
    issues = verifyIssues(routeIndex),
    prior = verifyScores(routeIndex, issues)
  const due = selectDueFluidHolderTargets(issues, prior, now(), maxScores)
  if (!due.length) return { routeKey: route.key, due: 0, scored: 0, deferred: 0 }
  const finalized = await sharedFinalized(origins)
  let scored = 0,
    deferred = 0
  for (const { issue, target } of due) {
    const deadlineMs = Date.parse(target.deadlineUtc)
    let block = null,
      identity = null,
      cases = null,
      positionAtTarget = null,
      status
    if (now() > deadlineMs) {
      if (finalized.timestamp * 1000 <= deadlineMs) {
        deferred++
        continue
      }
      status = 'capture_window_missed'
    } else {
      const selected = await firstFinalizedAfter(
        origins,
        issue.baseline,
        finalized,
        Date.parse(target.targetAtUtc),
      )
      if (!selected) {
        deferred++
        continue
      }
      if (selected.timestamp * 1000 > deadlineMs) {
        deferred++
        continue
      }
      block = {
        number: Number(selected.number),
        hash: selected.hash,
        timestamp: selected.timestamp,
        atUtc: selected.atUtc,
        origins: selected.origins,
      }
      identity = await identityAt(origins, route, selected)
      if (
        identity.runtimeHash !== issue.identity.runtimeHash ||
        identity.liquidityHash !== issue.identity.liquidityHash
      )
        status = 'identity_changed'
      else {
        positionAtTarget = await holderPosition(origins, route, selected, issue.holder)
        cases = []
        for (const q of issue.cases) {
          const entitlement = await holderEntitlement(
            origins,
            route,
            selected,
            issue.holder,
            BigInt(q.assetsRaw),
            positionAtTarget,
          )
          cases.push({
            label: q.label,
            assetsRaw: q.assetsRaw,
            entitlement,
            outcome:
              entitlement.status === 'covered'
                ? await assay(origins, route, selected, issue.holder, BigInt(q.assetsRaw))
                : null,
          })
        }
        status = 'measured'
      }
      await assertHeader(origins, selected)
    }
    const scoredAtUtc = utc(now())
    if (
      (status === 'measured' || status === 'identity_changed') &&
      Date.parse(scoredAtUtc) > deadlineMs
    ) {
      deferred++
      continue
    }
    appendChain(
      pathFor('scores', routeIndex),
      {
        study: 'fluid_ftoken_holder_score_v1',
        routeIndex,
        routeKey: route.key,
        issueSequence: issue.sequence,
        issueSha256: issue.sha256,
        horizonHours: target.horizonHours,
        targetAtUtc: target.targetAtUtc,
        scoredAtUtc,
        status,
        block,
        identity,
        cases,
        positionAtTarget,
        finalizedDeadlineWitness:
          status === 'capture_window_missed'
            ? {
                number: Number(finalized.number),
                hash: finalized.hash,
                timestamp: finalized.timestamp,
                origins: finalized.origins,
              }
            : null,
        interpretation: 'read_only_same_holder_callability_not_mined_delivery',
      },
      (r) => check(r.issueSha256 === issue.sha256, 'score_build_invalid'),
    )
    verifyScores(routeIndex, issues)
    scored++
  }
  return { routeKey: route.key, due: due.length, scored, deferred }
}

export function verifyAll() {
  return ROUTES.map((route, i) => {
    const issues = verifyIssues(i),
      scores = verifyScores(i, issues),
      attempts = readChain(pathFor('attempts', i))
    for (const attempt of attempts)
      check(
        attempt.study === 'fluid_ftoken_holder_attempt_v1' &&
          attempt.routeIndex === i &&
          attempt.routeKey === route.key &&
          ['issue', 'score'].includes(attempt.mode) &&
          ['completed', 'nothing_due', 'no_fresh_holder', 'deferred', 'failed'].includes(
            attempt.status,
          ) &&
          (attempt.status === 'failed') === (attempt.failure !== null) &&
          Date.parse(attempt.finishedAtUtc) >= Date.parse(attempt.startedAtUtc),
        'attempt_invalid',
      )
    return {
      routeKey: route.key,
      issues: issues.length,
      scores: scores.length,
      attempts: attempts.length,
    }
  })
}

/** Coarse public counts only. Holder, Q, source transaction, and target clock stay local. */
export function readPublicFluidHolderEvidence(routeKey, destination, nowMs = Date.now()) {
  const routeIndex = ROUTES.findIndex(
    (route) => route.key === routeKey && eq(route.vault, destination),
  )
  if (routeIndex < 0) return null
  const issues = verifyIssues(routeIndex)
  const scores = verifyScores(routeIndex, issues)
  const cells = HORIZONS_HOURS.map((horizonHours) => {
    let issuedCases = 0,
      baselineCallable = 0,
      measuredCases = 0,
      simulatedSuccess = 0,
      simulatedRevert = 0,
      holderIneligible = 0,
      entitlementUnassessed = 0,
      identityChanged = 0,
      pending = 0,
      censored = 0,
      outcomeMissing = 0
    for (const issue of issues) {
      issuedCases += issue.cases.length
      baselineCallable += issue.cases.filter((item) => item.baseline.status === 'success').length
      const plan = issue.targets.find((target) => target.horizonHours === horizonHours)
      const score = scores.find(
        (item) => item.issueSequence === issue.sequence && item.horizonHours === horizonHours,
      )
      if (score?.status === 'measured') {
        measuredCases += score.cases.filter((item) => item.entitlement.status === 'covered').length
        simulatedSuccess += score.cases.filter((item) => item.outcome?.status === 'success').length
        simulatedRevert += score.cases.filter(
          (item) => item.outcome?.status === 'evm_revert',
        ).length
        holderIneligible += score.cases.filter(
          (item) => item.entitlement.status === 'holder_ineligible',
        ).length
        entitlementUnassessed += score.cases.filter(
          (item) => item.entitlement.status === 'entitlement_unassessed',
        ).length
      } else if (score?.status === 'identity_changed') {
        identityChanged += issue.cases.length
      } else if (score?.status === 'capture_window_missed') censored += issue.cases.length
      else if (nowMs > Date.parse(plan.deadlineUtc)) outcomeMissing += issue.cases.length
      else pending += issue.cases.length
    }
    return {
      horizonHours,
      distinctIssueEpisodes: issues.length,
      issuedCases,
      baselineCallable,
      measuredCases,
      simulatedSuccess,
      simulatedRevert,
      holderIneligible,
      entitlementUnassessed,
      identityChanged,
      pending,
      censored,
      outcomeMissing,
    }
  })
  return {
    status: issues.length ? 'available' : 'unavailable',
    routeKey,
    destination: ROUTES[routeIndex].vault,
    scope: 'local_public_same_holder_eth_calls',
    countUnit: 'correlated_q_cases',
    calibratedForecast: false,
    minedDelivery: 'not_measured_by_prospective_lane',
    cells: issues.length ? cells : [],
  }
}
export function nextScanPlan(issueAttempts) {
  const last = issueAttempts.at(-1)
  if (last?.status === 'scan_budget_exhausted') {
    check(
      Number.isInteger(last.result?.scanWindow) && Number.isInteger(last.result?.nextOffset),
      'scan_attempt_invalid',
    )
    return { scanWindow: last.result.scanWindow, scanOffset: last.result.nextOffset }
  }
  return {
    scanWindow:
      issueAttempts.filter((row) => row.status !== 'scan_budget_exhausted').length % SCAN_WINDOWS,
    scanOffset: 0,
  }
}
/** Assign the next bounded score budget across all three verified route groups. */
export function planFluidScoreRoutes(routeRows, nowMs, budget = 3) {
  const next = routeRows
    .flatMap(({ routeIndex, issues, scores }) =>
      selectDueFluidHolderTargets(issues, scores, nowMs, budget).map(({ target }) => ({
        routeIndex,
        target,
      })),
    )
    .sort((a, b) => {
      const aDeadline = Date.parse(a.target.deadlineUtc)
      const bDeadline = Date.parse(b.target.deadlineUtc)
      return (
        Number(nowMs > aDeadline) - Number(nowMs > bDeadline) ||
        aDeadline - bDeadline ||
        Date.parse(a.target.targetAtUtc) - Date.parse(b.target.targetAtUtc) ||
        a.routeIndex - b.routeIndex
      )
    })
    .slice(0, budget)
  return next.map(({ routeIndex }) => ({ routeIndex, maxScores: 1 }))
}

export async function tick(mode, { origins = configuredClients(), now = Date.now } = {}) {
  check(['issue', 'score'].includes(mode), 'mode_invalid')
  const results = []
  const indices = ROUTES.map((_, i) => i)
  const failedPreflight = []
  const scorePlan =
    mode === 'score'
      ? planFluidScoreRoutes(
          indices.flatMap((routeIndex) => {
            try {
              const issues = verifyIssues(routeIndex)
              return [{ routeIndex, issues, scores: verifyScores(routeIndex, issues) }]
            } catch {
              failedPreflight.push(routeIndex)
              return []
            }
          }),
          now(),
        )
      : []
  const operations =
    mode === 'score'
      ? [...scorePlan, ...failedPreflight.map((routeIndex) => ({ routeIndex, maxScores: 1 }))]
      : indices.map((routeIndex) => ({ routeIndex, maxScores: 1 }))
  const blockedRoutes = new Set()
  for (const { routeIndex: i, maxScores } of operations) {
    if (blockedRoutes.has(i)) continue
    const startedAtUtc = utc(now())
    let result,
      status = 'completed',
      failure = null
    const issueAttempts =
      mode === 'issue'
        ? readChain(pathFor('attempts', i)).filter((row) => row.mode === 'issue')
        : []
    const scanPlan = mode === 'issue' ? nextScanPlan(issueAttempts) : null
    const scanWindow = scanPlan?.scanWindow ?? null
    const scanOffset = scanPlan?.scanOffset ?? 0
    try {
      result =
        mode === 'issue'
          ? await issueRoute(i, { origins, now, scanWindow, scanOffset })
          : await scoreDue(i, { origins, now, maxScores })
      if (result.status === 'no_fresh_holder') status = 'no_fresh_holder'
      if (result.status === 'scan_budget_exhausted') status = 'scan_budget_exhausted'
      if (mode === 'score' && result.due === 0) status = 'nothing_due'
      if (mode === 'score' && result.due && result.scored === 0) {
        status = 'deferred'
      }
    } catch (error) {
      status = 'failed'
      failure = String(error?.message || '').startsWith('fluid_holder_')
        ? String(error.message)
        : 'fluid_holder_external_failure'
      result = { routeKey: ROUTES[i].key, scanWindow, scanOffset }
    }
    if (mode === 'score' && (status === 'deferred' || status === 'failed')) blockedRoutes.add(i)
    const row = appendChain(
      pathFor('attempts', i),
      {
        study: 'fluid_ftoken_holder_attempt_v1',
        routeIndex: i,
        routeKey: ROUTES[i].key,
        mode,
        startedAtUtc,
        finishedAtUtc: utc(now()),
        status,
        failure,
        result,
      },
      (r) => check(r.mode === mode, 'attempt_build_invalid'),
    )
    results.push({ routeKey: ROUTES[i].key, status, attemptSequence: row.sequence, ...result })
  }
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  try {
    if (mode === 'verify') console.log(JSON.stringify(verifyAll()))
    else if (mode === 'issue' || mode === 'score') {
      const results = await tick(mode)
      console.log(JSON.stringify(results))
      if (results.some((result) => result.status === 'failed')) process.exitCode = 1
    } else throw Error('fluid_holder_mode_invalid')
  } catch (error) {
    console.error(
      String(error?.message || '').startsWith('fluid_holder_')
        ? error.message
        : 'fluid_holder_external_failure',
    )
    process.exitCode = 1
  }
}
