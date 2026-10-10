import type { RouteCashSample } from '@/lib/carry/routeCashForecast'

type Subject = { route_key: string; destination: string; asset: string }
type CashRow = {
  routeKey: string
  destination: string
  asset: string | null
  assetDecimals: number | null
  cashRaw: string | null
  state: string
  block: string
  blockHash: string
  blockAt: string
  collectionMode: string
  evidenceKind: string
  firstLocalReceiptAt: string
}
type Receipt = {
  collectionMode: string
  evidenceKind: string
  firstLocalReceiptAt: string
  source: { chainId: number; block: string; blockHash: string; blockAt: string }
  subjects: CashRow[]
}

const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/

/** The caller must first replay the full manifest-bound receipt chain. */
export function checkedLocalRouteCashSamples(
  receipts: readonly Receipt[],
  subject: Subject,
):
  | { status: 'available'; assetDecimals: number; samples: RouteCashSample[] }
  | {
      status: 'unavailable'
      reason:
        | 'no_current_samples'
        | 'subject_unassessed'
        | 'subject_no_code'
        | 'cash_identity_unverified'
    } {
  const current = receipts.filter((receipt) => receipt.collectionMode === 'current')
  if (!current.length) return { status: 'unavailable', reason: 'no_current_samples' }
  const samples: RouteCashSample[] = []
  let decimals: number | null = null
  let priorBlock = 0
  for (const receipt of current) {
    const rows = receipt.subjects.filter(
      (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
    )
    if (rows.length !== 1) return { status: 'unavailable', reason: 'cash_identity_unverified' }
    const row = rows[0]
    if (row.state === 'unassessed') return { status: 'unavailable', reason: 'subject_unassessed' }
    if (row.state === 'no_code') return { status: 'unavailable', reason: 'subject_no_code' }
    const block = Number(receipt.source.block)
    const at = Date.parse(receipt.source.blockAt)
    const received = Date.parse(receipt.firstLocalReceiptAt)
    if (
      receipt.evidenceKind !== 'current_finalized_observation' ||
      row.collectionMode !== 'current' ||
      row.evidenceKind !== 'current_finalized_observation' ||
      row.firstLocalReceiptAt !== receipt.firstLocalReceiptAt ||
      receipt.source.chainId !== 1 ||
      row.state !== 'observed' ||
      row.asset !== subject.asset ||
      !Number.isInteger(row.assetDecimals) ||
      row.assetDecimals === null ||
      row.assetDecimals < 0 ||
      row.assetDecimals > 36 ||
      (decimals !== null && row.assetDecimals !== decimals) ||
      !RAW.test(row.cashRaw ?? '') ||
      !Number.isSafeInteger(block) ||
      block <= priorBlock ||
      !HASH.test(receipt.source.blockHash) ||
      row.block !== receipt.source.block ||
      row.blockHash !== receipt.source.blockHash ||
      row.blockAt !== receipt.source.blockAt ||
      !Number.isFinite(at) ||
      !Number.isFinite(received) ||
      received < at
    )
      return { status: 'unavailable', reason: 'cash_identity_unverified' }
    const cashUnits = Number(row.cashRaw) / 10 ** row.assetDecimals
    if (!Number.isFinite(cashUnits) || cashUnits < 0)
      return { status: 'unavailable', reason: 'cash_identity_unverified' }
    decimals = row.assetDecimals
    priorBlock = block
    samples.push({
      block,
      observedAt: receipt.source.blockAt,
      firstAvailableAt: receipt.firstLocalReceiptAt,
      sourceId: `${block}:${receipt.source.blockHash}:${subject.destination}`,
      coverage: 'complete',
      cashUnits,
    })
  }
  return { status: 'available', assetDecimals: decimals!, samples }
}
