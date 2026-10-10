// Read-only, bounded second-origin replay of one already selected historical holder/Q cell.
// Transfer-log discovery is deliberately outside this verifier's claim.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { makeClient } from '../lib/venue-reads.mjs'
import { classifyProbe, lossIntervals } from './carry-morpho-exit-history-grid.mjs'
import {
  readSavedCell,
  validateCellResult,
  validatePlan,
} from './carry-morpho-stable-exit-history.mjs'

const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const TOKEN_ABI = parseAbi(['function decimals() view returns (uint8)'])
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const unavailable = (stage, detail = 'rpc_unavailable') => ({
  status: 'unavailable',
  stage,
  detail,
})
const mismatch = (stage, detail) => ({ status: 'mismatch', stage, detail })
const validRaw = (x) => typeof x === 'bigint' && x >= 0n

function errorClass(error) {
  let cursor = error
  let provenRevert = false
  for (let i = 0; cursor && i < 5; i++, cursor = cursor.cause) {
    const detail =
      `${cursor.name || ''} ${cursor.shortMessage || ''} ${cursor.message || ''}`.toLowerCase()
    if (/out of gas|gas limit|exceeds block gas|intrinsic gas/.test(detail)) return 'gas_error'
    if (cursor.name === 'HttpRequestError' || cursor.name === 'TimeoutError')
      return 'rpc_unavailable'
    if (
      cursor.name === 'RpcRequestError' &&
      cursor.code === 3 &&
      typeof cursor.data === 'string' &&
      /^0x(?:[0-9a-f]{2})+$/i.test(cursor.data)
    )
      provenRevert = true
  }
  return provenRevert ? 'evm_revert' : 'rpc_unavailable'
}

async function identity(client, subject, hash) {
  try {
    const [code, asset, shareDecimals, assetDecimals] = await Promise.all([
      client.getCode({ address: subject.vault, ...pin(hash) }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'asset',
        ...pin(hash),
      }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'decimals',
        ...pin(hash),
      }),
      client.readContract({
        address: subject.asset,
        abi: TOKEN_ABI,
        functionName: 'decimals',
        ...pin(hash),
      }),
    ])
    if (
      typeof asset !== 'string' ||
      !Number.isSafeInteger(Number(shareDecimals)) ||
      !Number.isSafeInteger(Number(assetDecimals))
    )
      return unavailable('identity')
    if (
      !code ||
      code === '0x' ||
      !same(asset, subject.asset) ||
      Number(shareDecimals) !== 18 ||
      Number(assetDecimals) !== 6
    )
      return {
        status: 'identity_changed',
        observedAsset: asset.toLowerCase(),
        shareDecimals: Number(shareDecimals),
        assetDecimals: Number(assetDecimals),
      }
    return { status: 'confirmed', shareDecimals: 18, assetDecimals: 6 }
  } catch {
    return unavailable('identity')
  }
}

async function state(client, subject, holder, q, hash) {
  try {
    const [code, shares, preview] = await Promise.all([
      client.getCode({ address: holder, ...pin(hash) }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'balanceOf',
        args: [holder],
        ...pin(hash),
      }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'previewWithdraw',
        args: [q],
        ...pin(hash),
      }),
    ])
    if (!validRaw(shares) || !validRaw(preview) || preview === 0n)
      return unavailable('holder_state')
    return {
      status: 'measured',
      eoa: !code || code === '0x',
      sharesRaw: shares.toString(),
      previewSharesRaw: preview.toString(),
    }
  } catch {
    return unavailable('holder_state')
  }
}

async function withdrawal(client, subject, holder, q, hash) {
  try {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: 'withdraw',
      args: [q, holder, holder],
    })
    const result = await client.call({
      account: holder,
      to: subject.vault,
      data,
      gas: 20_000_000n,
      ...pin(hash),
    })
    if (!result?.data) return unavailable('withdraw_call')
    const burned = decodeFunctionResult({ abi: ABI, functionName: 'withdraw', data: result.data })
    if (typeof burned !== 'bigint' || burned <= 0n) return unavailable('withdraw_call')
    return { status: 'success', sharesBurnedRaw: burned.toString() }
  } catch (error) {
    const status = errorClass(error)
    return status === 'rpc_unavailable' ? unavailable('withdraw_call') : { status }
  }
}

async function blockCheck(client, block, stage, firstAfterTarget = false) {
  try {
    const got = await client.getBlock({ blockNumber: BigInt(block.number) })
    if (
      got.number !== BigInt(block.number) ||
      !same(got.hash, block.hash) ||
      got.timestamp !== BigInt(block.timestamp)
    )
      return mismatch(stage, 'block_header_changed')
    if (firstAfterTarget) {
      const prior = await client.getBlock({ blockNumber: BigInt(block.number) - 1n })
      if (
        prior.number !== BigInt(block.number) - 1n ||
        !same(got.parentHash, prior.hash) ||
        prior.timestamp !== BigInt(block.priorTimestamp) ||
        prior.timestamp >= BigInt(block.requestedTimestamp) ||
        got.timestamp < BigInt(block.requestedTimestamp)
      )
        return mismatch(stage, 'first_target_block_disagreement')
    }
    return { status: 'confirmed' }
  } catch {
    return unavailable(stage)
  }
}

const probeClass = (stateResult, callResult) =>
  classifyProbe({ status: 'confirmed' }, stateResult, callResult)

/** The caller supplies the transport; no candidate rediscovery or writes occur. */
export async function verifyIndependentCell(client, plan, savedCell) {
  validatePlan(plan)
  validateCellResult(plan, savedCell)
  const cellIndex = plan.cells.findIndex(
    (x) => x.anchorBlock === savedCell.anchorBlock && x.vault === savedCell.vault,
  )
  if (cellIndex < 0) throw Error('cell_not_in_plan')
  const frozen = plan.cells[cellIndex]
  const schedule = plan.schedule.anchors[Math.floor(cellIndex / plan.subjects.length)]
  const subject = plan.subjects[cellIndex % plan.subjects.length]
  const report = {
    status: 'unavailable',
    discovery: 'saved_selection_not_independently_replayed',
    checkedProbes: 0,
    checkedIntervals: 0,
    stages: {},
  }
  const stop = (result, stage) => {
    report.status = result.status
    report.stages[stage] = result.detail || result.status
    return report
  }
  if (frozen.status !== 'frozen' || savedCell.status !== 'measured')
    return stop(unavailable('selection', 'no_saved_exact_holder'), 'selection')
  try {
    if ((await client.getChainId()) !== 1) return stop(mismatch('chain', 'chain_mismatch'), 'chain')
  } catch {
    return stop(unavailable('chain'), 'chain')
  }
  const checkpoints = [schedule.anchor, ...schedule.horizons.filter((h) => h.status === 'fixed')]
  for (const checkpoint of checkpoints) {
    const stage = checkpoint === schedule.anchor ? 'anchor_header' : `h${checkpoint.hours}_header`
    const result = await blockCheck(client, checkpoint, stage, checkpoint !== schedule.anchor)
    if (result.status !== 'confirmed') return stop(result, stage)
  }
  const anchorIdentity = await identity(client, subject, schedule.anchor.hash)
  if (anchorIdentity.status === 'unavailable') return stop(anchorIdentity, 'anchor_identity')
  if (anchorIdentity.status !== 'confirmed')
    return stop(mismatch('anchor_identity', 'route_or_decimals_changed'), 'anchor_identity')
  try {
    const [totalAssets, holderCode, anchorShares, anchorClaim] = await Promise.all([
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'totalAssets',
        ...pin(schedule.anchor.hash),
      }),
      client.getCode({ address: savedCell.row.holder, ...pin(schedule.anchor.hash) }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'balanceOf',
        args: [savedCell.row.holder],
        ...pin(schedule.anchor.hash),
      }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'previewRedeem',
        args: [BigInt(savedCell.row.anchorSharesRaw)],
        ...pin(schedule.anchor.hash),
      }),
    ])
    if (!validRaw(totalAssets) || !validRaw(anchorShares) || !validRaw(anchorClaim))
      return stop(unavailable('anchor_state'), 'anchor_state')
    if (
      totalAssets.toString() !== frozen.totalAssetsRaw ||
      (holderCode && holderCode !== '0x') ||
      anchorShares.toString() !== savedCell.row.anchorSharesRaw ||
      anchorClaim.toString() !== savedCell.row.anchorClaimRaw
    )
      return stop(mismatch('anchor_state', 'frozen_holder_or_vault_state_changed'), 'anchor_state')
  } catch {
    return stop(unavailable('anchor_state'), 'anchor_state')
  }
  report.stages.anchor = 'agreement'

  const horizonIdentities = new Map()
  for (const h of schedule.horizons.filter((x) => x.status === 'fixed')) {
    const found = await identity(client, subject, h.hash)
    if (found.status === 'unavailable') return stop(found, `h${h.hours}_identity`)
    horizonIdentities.set(h.hours, found)
  }
  for (const [sizeIndex, size] of savedCell.row.sizes.entries()) {
    if (!size.eligible) continue
    const q = BigInt(size.assetsRaw)
    const positions = [
      { key: 'baseline', hash: schedule.anchor.hash, saved: size.baseline },
      ...schedule.horizons
        .filter((h) => h.status === 'fixed')
        .map((h) => ({
          key: `h${h.hours}`,
          hash: h.hash,
          saved: size.horizons.find((x) => x.hours === h.hours),
        })),
    ]
    const independent = { ...size, baseline: null, horizons: [] }
    for (const position of positions) {
      const label = `q${sizeIndex + 1}_${position.key}`
      if (position.key !== 'baseline') {
        const hours = Number(position.key.slice(1))
        const observedIdentity = horizonIdentities.get(hours)
        if (!isDeepStrictEqual(position.saved?.identity, observedIdentity))
          return stop(mismatch(label, 'route_or_decimals_disagreement'), label)
        if (observedIdentity.status === 'identity_changed') {
          const absent = { status: 'not_read_identity' }
          const classification = classifyProbe(observedIdentity, absent, absent)
          if (
            position.saved?.class !== classification ||
            !isDeepStrictEqual(position.saved?.state, absent) ||
            !isDeepStrictEqual(position.saved?.call, absent)
          )
            return stop(mismatch(label, 'probe_disagreement'), label)
          independent.horizons.push({
            hours,
            identity: observedIdentity,
            state: absent,
            call: absent,
            class: classification,
          })
          report.checkedProbes++
          continue
        }
      }
      const holderState = await state(client, subject, savedCell.row.holder, q, position.hash)
      if (holderState.status === 'unavailable') return stop(holderState, label)
      const callResult = await withdrawal(client, subject, savedCell.row.holder, q, position.hash)
      if (callResult.status === 'unavailable') return stop(callResult, label)
      const classification = probeClass(holderState, callResult)
      if (
        position.saved?.class !== classification ||
        !isDeepStrictEqual(position.saved.state, holderState) ||
        !isDeepStrictEqual(position.saved.call, callResult)
      )
        return stop(mismatch(label, 'probe_disagreement'), label)
      report.checkedProbes++
      if (position.key === 'baseline')
        independent.baseline = { state: holderState, call: callResult, class: classification }
      else
        independent.horizons.push({
          hours: Number(position.key.slice(1)),
          identity: horizonIdentities.get(Number(position.key.slice(1))),
          state: holderState,
          call: callResult,
          class: classification,
        })
    }
    for (const h of schedule.horizons.filter((x) => x.status === 'head_censored'))
      independent.horizons.push({ hours: h.hours, class: 'head_censored' })
    independent.horizons.sort((a, b) => a.hours - b.hours)
    if (!isDeepStrictEqual(lossIntervals(independent), size.exitInterval))
      return stop(
        mismatch(`q${sizeIndex + 1}_interval`, 'loss_or_recovery_interval_disagreement'),
        `q${sizeIndex + 1}_interval`,
      )
    report.checkedIntervals++
  }
  if (report.checkedProbes === 0)
    return stop(unavailable('eligibility', 'no_eligible_q'), 'eligibility')
  report.status = 'agreement'
  report.stages.probes = 'agreement'
  report.stages.intervals = 'agreement'
  return report
}

export function parseArgs(args) {
  if (
    args.length !== 8 ||
    args[0] !== '--plan' ||
    args[2] !== '--directory' ||
    args[4] !== '--anchor' ||
    args[6] !== '--vault'
  )
    throw Error('usage: --plan FILE --directory DIR --anchor NUMBER --vault ADDRESS --rpc-url URL')
  const anchorBlock = Number(args[5])
  if (!Number.isSafeInteger(anchorBlock) || !/^0x[0-9a-f]{40}$/i.test(args[7]))
    throw Error('arguments_invalid')
  return { planPath: args[1], directory: args[3], anchorBlock, vault: args[7].toLowerCase() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const main = async () => {
    const args = process.argv.slice(2)
    const rpcIndex = args.indexOf('--rpc-url')
    if (rpcIndex < 0 || rpcIndex !== args.length - 2 || !args[rpcIndex + 1])
      throw Error('rpc_url_required')
    const rpcUrl = args[rpcIndex + 1]
    const { planPath, directory, anchorBlock, vault } = parseArgs(args.slice(0, rpcIndex))
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    const saved = readSavedCell(plan, anchorBlock, vault, directory)
    if (!saved) throw Error('cell_artifact_missing')
    const result = await verifyIndependentCell(makeClient(rpcUrl), plan, saved.cell)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.status !== 'agreement') process.exitCode = 1
  }
  main().catch(() => {
    // Never echo RPC URLs, nested provider errors, holder addresses, or amounts.
    process.stderr.write('independent_cell_verification_failed\n')
    process.exitCode = 1
  })
}
