import type { ForeignInitialDepositNativeReceipt, ForeignInitialDepositQuestion, ForeignInitialDepositSource } from './foreignInitialDepositProjection'

export type ForeignInitialDepositMethodOrigin = {
  hostSha256: string
  source: ForeignInitialDepositSource
  /** Caller must authenticate runtime/deployment identity and original read receipts. */
  deploymentReceiptSha256: string
  runtimeCodeHash: string
  vault: string; asset: string; assetDecimals: number; shareDecimals: number
  previewDeposit: { inputRaw: string; outputSharesRaw: string; receiptSha256: string }
  previewRedeem: { inputSharesRaw: string; outputAssetsRaw: string; receiptSha256: string }
  maxDeposit: { receiver: string | null; outputRaw: string | null; status: ForeignInitialDepositNativeReceipt['maxDepositStatus']; receiptSha256: string | null }
}
const originals = new WeakMap<object, string>()
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const raw = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < (1n << 256n)
const equal = (a: object, b: object) => JSON.stringify(Object.entries(a).sort(([a],[b])=>a.localeCompare(b))) === JSON.stringify(Object.entries(b).sort(([a],[b])=>a.localeCompare(b)))

/** Candidate methods are deliberately not assumed deployed. Only original authenticated
 * two-origin reads can enroll a native preview; serialized receipt-shaped data cannot. */
export function enrollForeignInitialDepositNativeReceipt(
  question: ForeignInitialDepositQuestion,
  origins: readonly [ForeignInitialDepositMethodOrigin, ForeignInitialDepositMethodOrigin],
  acquiredAtUtc: string,
  qualifyOriginal: (q: ForeignInitialDepositQuestion, origins: readonly [ForeignInitialDepositMethodOrigin, ForeignInitialDepositMethodOrigin]) => boolean,
): ForeignInitialDepositNativeReceipt | null {
  try {
    if (!qualifyOriginal(question, origins) || !question.originalDeposit ||
        !/^0x[a-f0-9]{40}$/.test(question.originalDeposit.asset) ||
        !Number.isInteger(question.originalDeposit.decimals) || question.originalDeposit.decimals < 0 || question.originalDeposit.decimals > 36 ||
        !raw(question.originalDeposit.raw) || question.originalDeposit.raw === '0') return null
    const [a,b] = origins
    if (!hash(a.hostSha256) || !hash(b.hostSha256) || a.hostSha256 === b.hostSha256 ||
        !equal(a.source, question.source) || !equal(b.source, question.source) ||
        !Number.isFinite(Date.parse(acquiredAtUtc)) || Date.parse(acquiredAtUtc) > Date.parse(question.issuedAtUtc) ||
        Date.parse(acquiredAtUtc) < Date.parse(question.source.readAt)) return null
    for (const o of origins) {
      if (!hash(o.deploymentReceiptSha256) || !/^0x[a-f0-9]{64}$/.test(o.runtimeCodeHash) ||
          o.vault !== question.destination || !/^0x[a-f0-9]{40}$/.test(o.asset) || o.assetDecimals !== question.nativeDecimals ||
          !Number.isInteger(o.shareDecimals) || o.shareDecimals < 0 || o.shareDecimals > 36 ||
          !hash(o.previewDeposit.receiptSha256) || !hash(o.previewRedeem.receiptSha256) ||
          o.previewDeposit.inputRaw !== question.nativeDepositRaw || !raw(o.previewDeposit.outputSharesRaw) || o.previewDeposit.outputSharesRaw === '0' ||
          o.previewRedeem.inputSharesRaw !== o.previewDeposit.outputSharesRaw || !raw(o.previewRedeem.outputAssetsRaw) ||
          o.maxDeposit.receiver !== question.receiver ||
          (question.receiver === null
            ? o.maxDeposit.status !== 'not_requested' || o.maxDeposit.outputRaw !== null || o.maxDeposit.receiptSha256 !== null
            : o.maxDeposit.status === 'quoted'
              ? !raw(o.maxDeposit.outputRaw) || !hash(o.maxDeposit.receiptSha256)
              : o.maxDeposit.status !== 'unavailable' || o.maxDeposit.outputRaw !== null || o.maxDeposit.receiptSha256 !== null)) return null
    }
    if (a.asset !== b.asset || a.assetDecimals !== b.assetDecimals || a.shareDecimals !== b.shareDecimals ||
        a.runtimeCodeHash !== b.runtimeCodeHash || a.previewDeposit.outputSharesRaw !== b.previewDeposit.outputSharesRaw ||
        a.previewRedeem.outputAssetsRaw !== b.previewRedeem.outputAssetsRaw ||
        a.maxDeposit.status !== b.maxDeposit.status || a.maxDeposit.outputRaw !== b.maxDeposit.outputRaw) return null
    const receipt: ForeignInitialDepositNativeReceipt = {
      question: structuredClone(question), nativeAsset: a.asset,
      mintedSharesRaw: a.previewDeposit.outputSharesRaw, shareDecimals: a.shareDecimals,
      fullNativeEntitlementRaw: a.previewRedeem.outputAssetsRaw,
      maxDepositRaw: a.maxDeposit.outputRaw, maxDepositStatus: a.maxDeposit.status,
      acquiredAtUtc, origins: [a.hostSha256,b.hostSha256], method: 'previewDeposit_D_then_previewRedeem_full_minted_S',
      evidenceRefs: origins.flatMap(o => [o.deploymentReceiptSha256,o.previewDeposit.receiptSha256,o.previewRedeem.receiptSha256,
        ...(o.maxDeposit.receiptSha256 ? [o.maxDeposit.receiptSha256] : [])]),
    }
    originals.set(receipt, JSON.stringify(receipt))
    return receipt
  } catch { return null }
}
export function originalQualifiedForeignNativeReceipt(value: unknown): value is ForeignInitialDepositNativeReceipt {
  try { return !!value && typeof value === 'object' && originals.get(value) === JSON.stringify(value) }
  catch { return false }
}
