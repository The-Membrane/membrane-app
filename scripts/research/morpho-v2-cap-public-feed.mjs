// Export a small, source-linked product feed from the verified prospective watcher.
// This is an onchain cap-action feed, not a prediction of withdrawable liquidity.
// node scripts/research/morpho-v2-cap-public-feed.mjs
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FACTORY_SHA, SUBMIT_SHA, readSources } from './morpho-v2-cap-lifecycle-census.mjs'
import { verify } from './morpho-v2-cap-prospective-watch.mjs'

export const STUDY = 'morpho-v2-cap-public-feed-v1'
const base = 'data/research/venue-signals'
const watchPath = `${base}/morpho-v2-cap-prospective-watch`
const outputPath = `${base}/morpho-v2-cap-public-feed.json`
const exactKey = (detail) => `${detail.vault}:${detail.selector}:${detail.data}`.toLowerCase()
const isHash = (value) => /^0x[0-9a-f]{64}$/i.test(value)

export function capMagnitude(kind, raw) {
  if (!/^[0-9]+$/.test(raw)) throw new Error('Invalid proposed cap')
  const value = BigInt(raw)
  if (kind === 'absolute') {
    return { proposedCapRaw: raw, capUnit: 'asset-base-units' }
  }
  if (kind !== 'relative' || value > 10n ** 18n) throw new Error('Invalid relative cap')
  return { proposedCapRaw: raw, capUnit: '1e18-fraction-of-vault-assets' }
}

export function buildFeed(segments, state, checkedAt) {
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid export timestamp')
  const latest = new Map()
  for (const segment of segments) {
    for (const event of segment.events) {
      if (!['submit', 'accept', 'revoke'].includes(event.kind)) continue
      const detail = event.detail
      const key = exactKey(detail)
      if (event.kind === 'submit') {
        if (
          !isHash(event.raw.transactionHash) ||
          !['absolute', 'relative'].includes(detail.cap?.kind) ||
          !isHash(detail.cap?.allocationId)
        )
          throw new Error('Invalid cap submission')
        // An exact-key resubmission starts a new lifecycle. The prior record is
        // superseded, rather than guessed to be canceled or executed.
        latest.set(key, {
          id: `${event.raw.transactionHash.toLowerCase()}:${event.raw.logIndex}`,
          protocol: 'Morpho Vault V2',
          vault: detail.vault,
          dimension:
            detail.cap.kind === 'absolute' ? 'absolute allocation cap' : 'relative allocation cap',
          direction: 'increase',
          allocationId: detail.cap.allocationId.toLowerCase(),
          ...capMagnitude(detail.cap.kind, detail.cap.proposedCap),
          lifecycle: 'queued',
          sourceUrl: `https://etherscan.io/tx/${event.raw.transactionHash}`,
          submittedBlock: event.raw.blockNumber,
          firstObservedAt: event.firstObservedAt,
          earliestExecutableAt: new Date(Number(detail.executableAt) * 1000).toISOString(),
          statusTxUrl: null,
          statusObservedAt: event.firstObservedAt,
        })
      } else {
        const record = latest.get(key)
        if (record?.lifecycle !== 'queued') continue
        record.lifecycle = event.kind === 'accept' ? 'executed' : 'canceled'
        record.statusTxUrl = `https://etherscan.io/tx/${event.raw.transactionHash}`
        record.statusObservedAt = event.firstObservedAt
      }
    }
  }
  const items = [...latest.values()].sort(
    (a, b) =>
      b.firstObservedAt.localeCompare(a.firstObservedAt) || b.submittedBlock - a.submittedBlock,
  )
  return {
    study: STUDY,
    source: 'Ethereum finalized Morpho Vault V2 Submit, Accept and Revoke events',
    scope: 'VaultV2 allocation cap increases observed by the local watcher only',
    checkedAt,
    coveredThroughBlock: state.throughBlock,
    items,
    limitation:
      'Cap permission can increase allocation headroom. It does not measure exit capacity or guarantee allocation.',
  }
}

export function seal(feed) {
  const bytes = JSON.stringify(feed)
  return { ...feed, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function main() {
  const sources = readSources(
    resolve(`${base}/${FACTORY_SHA}.json`),
    resolve(`${base}/${SUBMIT_SHA}.json`),
  )
  const state = verify({ out: resolve(watchPath), sources, requireExisting: true })
  const names = readdirSync(watchPath)
    .filter((name) => /^\d{12}-\d{12}\.json$/.test(name))
    .sort()
  const segments = names.map((name) => JSON.parse(readFileSync(join(watchPath, name), 'utf8')))
  // Export time is not observation time. Keep the last verified poll timestamp.
  const feed = seal(buildFeed(segments, state, state.firstObservedAt))
  const target = resolve(outputPath)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(feed))
  renameSync(temp, target)
  process.stdout.write(
    JSON.stringify({
      throughBlock: state.throughBlock,
      items: feed.items.length,
      output: outputPath,
    }) + '\n',
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
