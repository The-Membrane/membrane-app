/** Explicit local prewarm only: no RPC, credentials, startup work or shared cache. */
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { isAppOwnedMorphoV2IdleTrustedProfile, type MorphoV2IdleTrustedProfile } from './morphoV2IdleTrustedProfiles'
import {
  inspectMorphoV2IdleArchiveManifests, morphoV2IdleSafeArchivePath, MORPHO_V2_IDLE_HISTORY_LIMITS,
  replayMorphoV2IdleNativeHistory, type MorphoV2IdleNativeHistory,
} from './morphoV2IdleNativeEvidence'

function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error('morpho_idle_history_' + reason)
}
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.nlink === b.nlink && a.mode === b.mode && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const privateMode = (s: BigIntStats, mode: bigint) => (s.mode & 0o777n) === mode
const basename = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
/** All original bytes are read from the pinned companion, never from mutable working sources. */
export async function loadMorphoV2IdleHistory(
  profile: MorphoV2IdleTrustedProfile,
  options: Readonly<{ rootDirectory?: string }> = {},
): Promise<MorphoV2IdleNativeHistory> {
  check(isAppOwnedMorphoV2IdleTrustedProfile(profile), 'profile_identity')
  check(options.rootDirectory === undefined || typeof options.rootDirectory === 'string', 'root')
  const root = await realpath(options.rootDirectory ?? process.cwd())
  const directories: { path: string; identity: BigIntStats }[] = []
  const directoryPaths = new Set<string>()
  const readIdentities: { path: string; identity: BigIntStats }[] = []
  let totalBytes = 0, fileCount = 0, scannedFiles = 0
  const directory = async (relative: string) => {
    check(morphoV2IdleSafeArchivePath(relative) && /^data\/research\/venue-signals\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(relative), 'directory_path')
    const path = resolve(root, relative)
    check(relative.split('/').length <= 32 && (directoryPaths.has(path) || directoryPaths.size < 256), 'directory_budget')
    const before = await lstat(path, { bigint: true })
    check(before.isDirectory() && privateMode(before, 0o700n) && await realpath(path) === path, 'private_directory')
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { check(sameIdentity(before, await handle.stat({ bigint: true })), 'directory_identity') }
    finally { await handle.close() }
    check(sameIdentity(before, await lstat(path, { bigint: true })), 'directory_changed')
    const prior = directories.find(entry => entry.path === path)
    check(!prior || sameIdentity(prior.identity, before), 'directory_snapshot_changed')
    if (!prior) { directories.push({ path, identity: before }); directoryPaths.add(path) }
    return path
  }
  const nativeDirectory = await directory(profile.history.nativeDirectory)
  const companionDirectory = await directory(profile.history.companionDirectory)
  const read = async (directoryPath: string, name: string) => {
    check(profile.history.kind === 'rlusd_acceptance_v1' ? morphoV2IdleSafeArchivePath(name) : basename(name), 'basename')
    if (name.includes('/')) {
      const relativeBase = profile.history.companionDirectory
      check(directoryPath === companionDirectory, 'nested_archive_root')
      const segments = name.split('/').slice(0, -1)
      for (let i = 1; i <= segments.length; i++) await directory(relativeBase + '/' + segments.slice(0, i).join('/'))
    }
    const path = resolve(directoryPath, name), before = await lstat(path, { bigint: true })
    check(before.isFile() && before.nlink === 1n && privateMode(before, 0o600n) &&
      before.size > 0n && before.size <= BigInt(MORPHO_V2_IDLE_HISTORY_LIMITS.fileBytes), 'private_file')
    const size = Number(before.size)
    check(++fileCount <= MORPHO_V2_IDLE_HISTORY_LIMITS.files && totalBytes + size <= MORPHO_V2_IDLE_HISTORY_LIMITS.totalBytes, 'read_budget')
    totalBytes += size
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      check(sameIdentity(before, await handle.stat({ bigint: true })), 'opened_file_changed')
      bytes = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const result = await handle.read(bytes, offset, size - offset, offset)
        check(result.bytesRead > 0, 'short_read'); offset += result.bytesRead
      }
      const extra = Buffer.alloc(1)
      check((await handle.read(extra, 0, 1, size)).bytesRead === 0 && sameIdentity(before, await handle.stat({ bigint: true })), 'file_changed')
    } finally { await handle.close() }
    check(sameIdentity(before, await lstat(path, { bigint: true })), 'readback_identity')
    const text = bytes.toString('utf8')
    check(Buffer.from(text, 'utf8').equals(bytes), 'utf8')
    readIdentities.push({ path, identity: before })
    return text
  }
  const nativeFiles: Record<string, string> = Object.create(null)
  const companionFiles: Record<string, string> = Object.create(null)
  nativeFiles['terminal.json'] = await read(nativeDirectory, 'terminal.json')
  const companionManifestText = await read(companionDirectory, 'manifest.json')
  const manifest = inspectMorphoV2IdleArchiveManifests(profile, nativeFiles['terminal.json'], companionManifestText)
  const closedSet = async (path: string, names: string[]) => {
    const actual: string[] = []
    const walk = async (base: string, prefix = '') => {
      check(prefix.split('/').length <= 32, 'directory_depth')
      await directory(base.slice(root.length + 1))
      const handle = await opendir(base, { bufferSize: 8 })
      let entryCount = 0
      try {
        for (;;) {
          const entry = await handle.read()
          if (entry === null) break
          check(++entryCount <= MORPHO_V2_IDLE_HISTORY_LIMITS.files, 'directory_entry_budget')
          const name = prefix + entry.name
          check(morphoV2IdleSafeArchivePath(name), 'archive_member_path')
          if (entry.isDirectory() && profile.history.kind === 'rlusd_acceptance_v1') {
            check(names.some(expected => expected.startsWith(name + '/')), 'unexpected_archive_directory')
            await walk(resolve(base, entry.name), name + '/')
          } else {
            check(entry.isFile(), 'archive_member_type')
            check(++scannedFiles <= MORPHO_V2_IDLE_HISTORY_LIMITS.files, 'closed_set_file_budget')
            actual.push(name)
          }
        }
      } finally { await handle.close() }
      await directory(base.slice(root.length + 1))
    }
    await walk(path)
    check(actual.length === names.length && JSON.stringify(actual.sort()) === JSON.stringify([...names].sort()), 'directory_closed_set')
  }
  await closedSet(nativeDirectory, manifest.nativeNames)
  await closedSet(companionDirectory, [...manifest.companionNames, 'manifest.json'])
  for (const name of manifest.nativeNames) if (name !== 'terminal.json') nativeFiles[name] = await read(nativeDirectory, name)
  for (const name of manifest.companionNames) companionFiles[name] = await read(companionDirectory, name)
  for (const entry of readIdentities) check(sameIdentity(entry.identity, await lstat(entry.path, { bigint: true })), 'snapshot_file_changed')
  for (const entry of directories) check(sameIdentity(entry.identity, await lstat(entry.path, { bigint: true })), 'snapshot_directory_changed')
  let normalizationTexts: { manifestText: string; factsText: string; rootReadbackText: string } | undefined
  if (profile.history.kind === 'rlusd_acceptance_v1') {
    check(profile.history.normalization, 'normalization_descriptor')
    const normalizedDirectory = await directory(profile.history.normalization.directory)
    normalizationTexts = {
      manifestText: await read(normalizedDirectory, 'manifest.json'),
      factsText: await read(normalizedDirectory, 'rlusd-original-research-facts.json'),
      rootReadbackText: await read(normalizedDirectory, 'root-readback.json'),
    }
  }
  const history = replayMorphoV2IdleNativeHistory(profile, { nativeFiles, companionManifestText, companionFiles, ...(normalizationTexts ? { normalizationTexts } : {}) })
  for (const entry of readIdentities) check(sameIdentity(entry.identity, await lstat(entry.path, { bigint: true })), 'replayed_snapshot_file_changed')
  for (const entry of directories) check(sameIdentity(entry.identity, await lstat(entry.path, { bigint: true })), 'replayed_snapshot_directory_changed')
  return history
}
