import frame from '@/data/research/venue-signals/morpho-v2-protocol-capacity-history-pilot-2026-10-07T15-32.frame.json'
import type { MorphoV2HolderTimeProcessInput } from './morphoV2HolderTimeProcess'

export type MorphoV2Sha256Text = (text: string) => string

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => exact(value, b[index]))
    )
  if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object'))
    return (
      a !== null &&
      typeof a === 'object' &&
      b !== null &&
      typeof b === 'object' &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        (key) =>
          Object.hasOwn(b, key) &&
          exact((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    )
  return Object.is(a, b)
}

const trusted = freeze(structuredClone(frame)) as MorphoV2HolderTimeProcessInput['history']

export const MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN = freeze({
  frameSha256: 'd1062504e5d1e01c9183b1bc65654fc6a28c5e82571c0f021a7f3f7ee5ce8c6b',
  rawFileSha256: 'ddf285e8d5209390ce2b8c42867b092fa36ddaf0a8759e2a83dd92805740f970',
  captureReceiptSha256: '4442d5f337123ee4d47e3bce8a02a92909901d43affefe64709f6b41b15dcaa1',
  knowledgeCutoff: trusted.knowledgeCutoff,
})

/** Returns a clone of the app-shipped full historical replay frame, never API history. */
export function morphoV2PinnedProtocolHistory(): MorphoV2HolderTimeProcessInput['history'] {
  return structuredClone(trusted)
}

/** The fixed frame digest and exact full-frame equality are both required. */
export function approveMorphoV2PinnedProtocolHistory(
  candidate: unknown,
  sha256Text: MorphoV2Sha256Text,
): boolean {
  try {
    return (
      sha256Text(JSON.stringify(trusted)) === MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN.frameSha256 &&
      exact(structuredClone(candidate), trusted)
    )
  } catch {
    return false
  }
}
