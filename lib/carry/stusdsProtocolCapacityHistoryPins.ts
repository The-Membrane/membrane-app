import evidence from '@/data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.export.json'

function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
export const STUSDS_PROTOCOL_CAPACITY_HISTORY_PIN = freeze({
  exportFileSha256: 'f4b1ec1130f300d43e0ec7d0a60f9f18c4c17b2580a32460f8d5add533bd08fe',
  rawFileSha256: '525aa24f506c23d91d7c74c27215c0fee73f04ccbfcca3c8f2312c42e118a294',
  captureReceiptSha256: evidence.captureReceiptSha256,
  knowledgeCutoff: evidence.knowledgeCutoff,
  asset: evidence.asset,
  assetDecimals: evidence.assetDecimals,
  history: evidence.history,
})
export type StusdsProtocolPoint = Omit<typeof evidence.current, 'holderQuote'> & {
  holderQuote?: typeof evidence.current.holderQuote
}
export function stusdsPinnedProtocolHistory() {
  return structuredClone(STUSDS_PROTOCOL_CAPACITY_HISTORY_PIN)
}
