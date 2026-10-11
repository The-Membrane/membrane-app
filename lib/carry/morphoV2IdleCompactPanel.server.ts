/** One pinned <=64KiB leaf. Original raw replay stays offline, outside the request path. */
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pinnedMorphoV2IdleCompactPanel } from './morphoV2IdleCompactPanelEvidence'
import { MORPHO_V2_IDLE_COMPACT_PANEL_PIN } from './morphoV2IdleCompactPanelPin'
import type { MorphoV2IdleCompact120Panel } from './morphoV2IdleCompact120Panel'
import { isAppOwnedMorphoV2IdleTrustedProfile, type MorphoV2IdleTrustedProfile } from './morphoV2IdleTrustedProfiles'

declare const originalPanel: unique symbol
export type OriginalMorphoV2IdleCompactPanel = Readonly<{ text: string; panel: MorphoV2IdleCompact120Panel; sha256: string; readonly [originalPanel]: true }>
const originals = new WeakMap<object, MorphoV2IdleTrustedProfile>()
const sameIdentity = (a: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }, b: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
export function isOriginalMorphoV2IdleCompactPanel(value: unknown, profile: MorphoV2IdleTrustedProfile): value is OriginalMorphoV2IdleCompactPanel {
  return Boolean(value && typeof value === 'object' && isAppOwnedMorphoV2IdleTrustedProfile(profile) && originals.get(value) === profile)
}
/** Pending pin or any identity/content failure declines; no writes, cache, discovery or RPC. */
export async function loadMorphoV2IdleCompactPanel(profile: MorphoV2IdleTrustedProfile, options: { rootDirectory?: string } = {}): Promise<OriginalMorphoV2IdleCompactPanel | null> {
  try {
    const pin = MORPHO_V2_IDLE_COMPACT_PANEL_PIN
    if (!isAppOwnedMorphoV2IdleTrustedProfile(profile) || !profile.history.compactPanel || pin.relativePath === null || pin.sha256 === null || pin.bytes === null || pin.bytes <= 0 || pin.bytes > 65536 || !/^data\/research\/venue-signals\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\.json$/.test(pin.relativePath)) return null
    const root = await realpath(options.rootDirectory ?? process.cwd()), path = resolve(root, pin.relativePath), parent = dirname(path)
    if (!path.startsWith(root + sep) || await realpath(parent) !== parent) return null
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const beforeDirectory = await directory.stat({ bigint: true })
      if (!beforeDirectory.isDirectory() || (beforeDirectory.mode & 0o022n) !== 0n) return null
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await file.stat({ bigint: true })
        if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(pin.bytes) || (before.mode & 0o022n) !== 0n) return null
        const buffer = Buffer.alloc(pin.bytes + 1)
        let offset = 0
        while (offset < buffer.length) { const read = await file.read(buffer, offset, buffer.length - offset, offset); if (read.bytesRead === 0) break; offset += read.bytesRead }
        if (offset !== pin.bytes) return null
        const data = buffer.subarray(0, offset), after = await file.stat({ bigint: true }), afterDirectory = await directory.stat({ bigint: true })
        if (!sameIdentity(before, after) || !sameIdentity(beforeDirectory, afterDirectory)) return null
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data), panel = pinnedMorphoV2IdleCompactPanel(text, profile)
        if (!panel) return null
        const result = Object.freeze({ text, panel, sha256: pin.sha256 }) as unknown as OriginalMorphoV2IdleCompactPanel
        originals.set(result, profile); return result
      } finally { await file.close() }
    } finally { await directory.close() }
  } catch { return null }
}
