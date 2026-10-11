// One fixed same-holder apxUSD-Q issue. Success means receipt initiation only.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, stringToHex, toFunctionSelector } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  ADDRESS,
  ASSET,
  DECIMAL,
  HEX,
  HORIZONS,
  OUT_ROOT,
  RECEIPT,
  ROUTE,
  VAULT,
  appendChain,
  assay,
  attestIdentity,
  canonical,
  independentPairs,
  pin,
  readChain,
  readHeader,
  seal,
  sha,
  utc,
} from './carry-public-apyusd-exit-common.mjs'

export const STUDY = 'carry_public_apyusd_exit_issue_v1'
export const OUT = resolve(OUT_ROOT, 'carry-public-apyusd-exit-issues')
const TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/
const SLOT_MS = 15 * 60_000

async function findFreshHolder(primary, secondary, header, prior) {
  const used = new Set(prior.map((row) => row.holder))
  const candidates = new Set()
  const end = BigInt(header.number)
  const start = end > 5000n ? end - 4999n : 0n
  const query = (low, high) =>
    primary.request('eth_getLogs', [
      {
        address: VAULT,
        topics: [TOPIC],
        fromBlock: `0x${low.toString(16)}`,
        toBlock: `0x${high.toString(16)}`,
      },
    ])
  let windows
  try {
    windows = [await query(start, end)]
  } catch {
    // A few providers cap eth_getLogs at ten blocks. Bound this fallback.
    windows = []
    const fallback = end > 511n ? end - 511n : 0n
    await query(end > 9n ? end - 9n : 0n, end)
    for (let low = fallback; low <= end; low += 10n)
      windows.push(await query(low, low + 9n > end ? end : low + 9n))
  }
  for (const logs of windows) {
    if (!Array.isArray(logs) || logs.length > 1000) throw Error('apyusd_candidate_logs_invalid')
    for (const log of logs) {
      if (log.address?.toLowerCase() !== VAULT || log.topics?.[0] !== TOPIC) continue
      for (const topic of log.topics.slice(1, 3))
        if (ADDRESS_WORD.test(topic ?? '')) {
          const holder = `0x${topic.slice(-40)}`
          if (!/^0x0{40}$/.test(holder) && !used.has(holder)) candidates.add(holder)
        }
    }
    if (candidates.size >= 64) break
  }
  const balanceSelector = toFunctionSelector('balanceOf(address)')
  const maxSelector = toFunctionSelector('maxWithdraw(address)')
  const results = []
  for (const holder of [...candidates].slice(0, 64)) {
    const code = await primary.request('eth_getCode', [holder, pin(header.hash)])
    if (code !== '0x') continue
    const data = (selector) => `${selector}${holder.slice(2).padStart(64, '0')}`
    const [balance, limit, witnessBalance, witnessLimit, witnessCode] = await Promise.all([
      primary.request('eth_call', [{ to: VAULT, data: data(balanceSelector) }, pin(header.hash)]),
      primary.request('eth_call', [{ to: VAULT, data: data(maxSelector) }, pin(header.hash)]),
      secondary.request('eth_call', [{ to: VAULT, data: data(balanceSelector) }, pin(header.hash)]),
      secondary.request('eth_call', [{ to: VAULT, data: data(maxSelector) }, pin(header.hash)]),
      secondary.request('eth_getCode', [holder, pin(header.hash)]),
    ])
    if (
      !HEX.test(balance ?? '') ||
      !HEX.test(limit ?? '') ||
      balance !== witnessBalance ||
      limit !== witnessLimit ||
      witnessCode !== '0x'
    )
      throw Error('apyusd_candidate_origin_disagreement')
    if (BigInt(balance) > 0n && BigInt(limit) > 0n)
      results.push({
        holder,
        sharesRaw: BigInt(balance).toString(),
        maxRaw: BigInt(limit).toString(),
      })
  }
  results.sort((a, b) =>
    BigInt(a.maxRaw) > BigInt(b.maxRaw)
      ? -1
      : BigInt(a.maxRaw) < BigInt(b.maxRaw)
        ? 1
        : a.holder.localeCompare(b.holder),
  )
  return results[0] ?? null
}

function fixedCases(maxRaw) {
  const max = BigInt(maxRaw)
  const values = [10n ** 18n, 10n ** 19n, 10n ** 20n, max / 4n, max / 2n, max]
  const used = new Set()
  return values.map((q, index) => {
    const assetsRaw = q > 0n && !used.has(q.toString()) ? q.toString() : null
    if (assetsRaw) used.add(assetsRaw)
    return { label: `q${index + 1}`, assetsRaw }
  })
}

export function validateApyUsdIssue(row) {
  if (
    row?.study !== STUDY ||
    row.routeKey !== ROUTE ||
    row.destination !== VAULT ||
    row.originalAsset !== ASSET ||
    row.receipt !== RECEIPT ||
    !ADDRESS.test(row.holder ?? '') ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !HEX.test(row.baseline?.hash ?? '') ||
    !DECIMAL.test(row.baseline?.number ?? '') ||
    row.baseline?.identity?.vaultImpl !== '0xfd616567ecc1607f61073951a1e822f7315bb112' ||
    row.baseline?.identity?.receiptImpl !== '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982' ||
    row.baseline?.originA === row.baseline?.originB ||
    !DECIMAL.test(row.holderSharesRaw ?? '') ||
    !DECIMAL.test(row.maxWithdrawRaw ?? '') ||
    BigInt(row.holderSharesRaw) === 0n ||
    BigInt(row.maxWithdrawRaw) === 0n ||
    !Array.isArray(row.cases) ||
    row.cases.length !== 6 ||
    canonical(row.horizonsHours) !== canonical(HORIZONS) ||
    row.finalPayout !== 'unmeasured_no_onchain_owned_receipt' ||
    utc(row.issuedAtUtc) < row.baseline.timestamp * 1000 ||
    utc(row.issuedAtUtc) - row.baseline.timestamp * 1000 > 3_600_000 ||
    row.slot !== Math.floor(utc(row.issuedAtUtc) / SLOT_MS)
  )
    throw Error('apyusd_issue_invalid')
  if (
    canonical(row.targets) !==
    canonical(
      HORIZONS.map((hours) => ({
        horizonHours: hours,
        targetAtUtc: new Date(utc(row.issuedAtUtc) + hours * 3_600_000).toISOString(),
        captureDeadlineUtc: new Date(utc(row.issuedAtUtc) + (hours + 2) * 3_600_000).toISOString(),
      })),
    )
  )
    throw Error('apyusd_issue_targets_invalid')
  for (const [index, item] of row.cases.entries()) {
    if (
      item.label !== `q${index + 1}` ||
      item.assetsRaw !== fixedCases(row.maxWithdrawRaw)[index].assetsRaw
    )
      throw Error('apyusd_issue_q_invalid')
    if (item.assetsRaw === null) {
      if (item.status !== 'omitted' || item.baseline !== null)
        throw Error('apyusd_issue_omitted_invalid')
    } else if (
      item.status !== 'measured' ||
      !['initiation_success', 'evm_revert'].includes(item.baseline?.status) ||
      canonical(item.baseline?.primary) !== canonical(item.baseline?.secondary) ||
      item.baseline?.status !== item.baseline?.primary?.status ||
      item.baseline?.payout !== 'not_delivered_by_initiation'
    )
      throw Error('apyusd_issue_measurement_invalid')
  }
  return row
}

export async function verifyApyUsdIssues(out = OUT) {
  const rows = await readChain(out)
  const holders = new Set()
  for (const row of rows) {
    validateApyUsdIssue(row)
    if (holders.has(row.holder)) throw Error('apyusd_repeated_holder')
    holders.add(row.holder)
  }
  return rows
}

export async function issueApyUsd({
  urls = configuredPublicRpcUrls(readEnv()),
  now = () => new Date(),
  pairs = independentPairs(urls),
  load = verifyApyUsdIssues,
} = {}) {
  const prior = await load()
  const started = Date.now()
  for (const [primary, secondary] of pairs) {
    try {
      const header = await readHeader(primary)
      const witness = await readHeader(secondary, `0x${BigInt(header.number).toString(16)}`)
      const secondaryFinalized = await readHeader(secondary)
      if (
        canonical(header) !== canonical(witness) ||
        BigInt(secondaryFinalized.number) < BigInt(header.number) ||
        Date.now() - header.timestamp * 1000 > 3_600_000
      )
        throw Error('apyusd_header_disagreement')
      const identities = await Promise.all([
        attestIdentity(primary, header.hash),
        attestIdentity(secondary, header.hash),
      ])
      if (canonical(identities[0]) !== canonical(identities[1]))
        throw Error('apyusd_identity_disagreement')
      const candidate = await findFreshHolder(primary, secondary, header, prior)
      if (!candidate) throw Error('apyusd_no_fresh_holder')
      const cases = []
      for (const item of fixedCases(candidate.maxRaw)) {
        if (item.assetsRaw === null) {
          cases.push({ ...item, status: 'omitted', baseline: null })
          continue
        }
        const [a, b] = await Promise.all([
          assay(primary, candidate.holder, item.assetsRaw, header.hash),
          assay(secondary, candidate.holder, item.assetsRaw, header.hash),
        ])
        if (canonical(a) !== canonical(b)) throw Error('apyusd_assay_origin_disagreement')
        cases.push({
          ...item,
          status: 'measured',
          baseline: {
            status: a.status,
            primary: a,
            secondary: b,
            payout: 'not_delivered_by_initiation',
          },
        })
      }
      const issuedAtUtc = now().toISOString()
      const row = seal({
        study: STUDY,
        sequence: prior.length + 1,
        previousSha256: prior.at(-1)?.sha256 ?? null,
        routeKey: ROUTE,
        destination: VAULT,
        originalAsset: ASSET,
        receipt: RECEIPT,
        holder: candidate.holder,
        holderSharesRaw: candidate.sharesRaw,
        maxWithdrawRaw: candidate.maxRaw,
        issuedAtUtc,
        slot: Math.floor(utc(issuedAtUtc) / SLOT_MS),
        baseline: {
          ...header,
          identity: identities[0],
          originA: primary.provider,
          originB: secondary.provider,
        },
        horizonsHours: HORIZONS,
        targets: HORIZONS.map((hours) => ({
          horizonHours: hours,
          targetAtUtc: new Date(utc(issuedAtUtc) + hours * 3_600_000).toISOString(),
          captureDeadlineUtc: new Date(utc(issuedAtUtc) + (hours + 2) * 3_600_000).toISOString(),
        })),
        cases,
        finalPayout: 'unmeasured_no_onchain_owned_receipt',
      })
      validateApyUsdIssue(row)
      await appendChain(row, OUT, verifyApyUsdIssues)
      return {
        sequence: row.sequence,
        cases: row.cases.length,
        baselineSuccess: row.cases.filter((item) => item.baseline?.status === 'initiation_success')
          .length,
      }
    } catch (error) {
      if (error.message === 'apyusd_no_fresh_holder') continue
      if (Date.now() - started > 7 * 60_000) throw Error('apyusd_rpc_budget_exhausted')
    }
  }
  throw Error('apyusd_two_origin_issue_failed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--verify')
      console.log(JSON.stringify({ issues: (await verifyApyUsdIssues()).length }))
    else if (process.argv[2] === '--issue') console.log(JSON.stringify(await issueApyUsd()))
    else throw Error('apyusd_issue_usage')
  } catch {
    process.stderr.write('public_apyusd_issue_failed\n')
    process.exitCode = 1
  }
}
