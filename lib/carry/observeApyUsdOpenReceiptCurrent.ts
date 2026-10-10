import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ApyUsdOpenReceiptObservation = {
  observationStatus: string
  scope: string
  prospectiveQForecast: boolean
  holderCodeChecked: boolean
  origins: string[]
  block: { number: number; hash: string; timestamp: number }
  observedAtUtc: string
  subjects: { tokenId: string; holder: string; receiptEscrowRaw: string }[]
  proofs: {
    tokenId: string
    status: string
    currentOwner?: string
    isClaimable?: boolean
    claimStatus?: string
    claimAmountRaw?: string | null
    holderCodeStatus?: 'no_code' | 'eip7702_delegated' | 'contract_code'
  }[]
}

// Run the existing read-only CLI in native ESM: Next's API runtime cannot load
// its top-level-await entry as CommonJS. No capture mode or output path is used.
export async function observeApyUsdOpenReceiptCurrent(): Promise<ApyUsdOpenReceiptObservation> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['scripts/research/apyusd-open-receipt-current.mjs', '--observe'],
    { cwd: process.cwd(), timeout: 120_000, maxBuffer: 100_000 },
  )
  return JSON.parse(stdout) as ApyUsdOpenReceiptObservation
}
