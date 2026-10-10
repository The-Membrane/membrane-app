import usdc from '@/data/research/venue-signals/fluid-protocol-capacity-history-usdc-oct2-2026-10-07.export.json'
import usdt from '@/data/research/venue-signals/fluid-protocol-capacity-history-usdt-oct2-2026-10-07.export.json'
import gho from '@/data/research/venue-signals/fluid-protocol-capacity-history-gho-oct2-2026-10-07.export.json'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
export const FLUID_PROTOCOL_CAPACITY_HISTORY_PINS = deepFreeze([
  {
    id: 'fluid-usdc-oct2-10884s',
    compact: usdc,
    compactFileName: 'fluid-protocol-capacity-history-usdc-oct2-2026-10-07.export.json',
    compactFileSha256: 'f3911dd6361017f901a12654c83823de78b66e6219036d8eb1b3b66ee6802cf6',
    proofFileName: 'fluid-protocol-capacity-history-usdc-oct2-2026-10-07.json',
    proofFileSha256: '13c2a1d642bfa7c5a6f9a95eb87ed8831960d494af6c8cbc094eaa40ab53573f',
    contentSha256: '7c6a1e1c0111aa5aa3a81d769e556bf00a8eaa23271bb09644c7bca707115a68',
  },
  {
    id: 'fluid-usdt-oct2-10884s',
    compact: usdt,
    compactFileName: 'fluid-protocol-capacity-history-usdt-oct2-2026-10-07.export.json',
    compactFileSha256: '86ce18b72109a95e3053cb2e29a97bb888d685a9160ae0f02edd2cfea3d8d060',
    proofFileName: 'fluid-protocol-capacity-history-usdt-oct2-2026-10-07.json',
    proofFileSha256: 'a507e2e084ff5f12c40be0156f5ecacc02534ff467df19bc52563750dab0e8c1',
    contentSha256: 'b0635158c8534a276aeb0061389929c6d6baec03a507691d1c3e7c836c3b7bc0',
  },
  {
    id: 'fluid-gho-oct2-10884s',
    compact: gho,
    compactFileName: 'fluid-protocol-capacity-history-gho-oct2-2026-10-07.export.json',
    compactFileSha256: '66a5d0b9cdfaf9bb7e8821c100a82c6dd97575ef0e48fd8d8afdcbdb7ce83451',
    proofFileName: 'fluid-protocol-capacity-history-gho-oct2-2026-10-07.json',
    proofFileSha256: 'b2fb99c7e25704e122bbb75503b3d36b45de7ecf438a310e7476e648896e3c24',
    contentSha256: '41568bf8b2922d51f73cf50c06765cdf82147d092e4c2439c9e9fd4e9037cc3a',
  },
])
export function fluidProtocolHistoryPinForSubject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  return (
    FLUID_PROTOCOL_CAPACITY_HISTORY_PINS.find(
      ({ compact: { subject: s } }) =>
        v.routeKey === s.routeKey &&
        v.destination === s.destination &&
        v.asset === s.asset &&
        v.assetDecimals === s.assetDecimals,
    ) ?? null
  )
}
