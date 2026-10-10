import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isAppOwnedMorphoV2IdleTrustedProfile, resolveMorphoV2IdleTrustedProfile,
  type MorphoV2IdleTrustedProfile,
} from '../../lib/carry/morphoV2IdleTrustedProfiles'
import { loadMorphoV2IdleHistory } from '../../lib/carry/morphoV2IdleHistory.server'
import {
  decodeMorphoV2IdleNativePoint, isOriginalMorphoV2IdleNativeHistory,
  morphoV2IdleHistoricalPreviewDescriptors, morphoV2IdlePreviewRedeemCalldata,
  replayMorphoV2IdleNativeHistory, selectMorphoV2IdleHistoryForStock,
  type MorphoV2IdleArchiveTexts, type MorphoV2IdleNativeHistory, type MorphoV2IdleNativeTrace,
} from '../../lib/carry/morphoV2IdleNativeEvidence'

const profile = resolveMorphoV2IdleTrustedProfile('PYUSD → VaultV2 [PYUSD]',
  '0xb576765fb15505433af24fee2c0325895c559fb2', '0x6c3ea9036406852006290770bedfcaba0e23a0e8')!
let archive: MorphoV2IdleArchiveTexts, history: MorphoV2IdleNativeHistory
const temporary: string[] = []
async function readDirectory(path: string) {
  const texts: Record<string, string> = {}
  for (const name of await readdir(path)) texts[name] = await readFile(join(path, name), 'utf8')
  return texts
}
beforeAll(async () => {
  const nativeFiles = await readDirectory(join(process.cwd(), profile.history.nativeDirectory))
  const preserved = await readDirectory(join(process.cwd(), profile.history.companionDirectory))
  const { 'manifest.json': companionManifestText, ...companionFiles } = preserved
  archive = { nativeFiles, companionManifestText, companionFiles }
  history = await loadMorphoV2IdleHistory(profile)
})
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })
function traces(label: string): MorphoV2IdleNativeTrace[] {
  return Object.entries(archive.nativeFiles).filter(([name]) => name.startsWith('native-row-')).sort().map(([, text]) => {
    const row = JSON.parse(text).row
    return { host: row.observation.host, key: row.request.key, physicalId: row.physicalId,
      request: row.observation.request, envelope: JSON.parse(Buffer.from(row.observation.rawBodyBase64, 'base64').toString('utf8')) }
  }).filter((trace) => trace.key.startsWith(label + ':'))
}
function pointInput() {
  return { label: 'current', source: history.capturedCurrent.observation.historicalPoint.source,
    owner: profile.history.captureOwner, probeSharesRaw: history.captureSharesRaw,
    traces: traces('current'), currentCaptureReference: true }
}
function nativeChange(name: string, text: string) {
  return { ...archive, nativeFiles: { ...archive.nativeFiles, [name]: text } }
}
async function fixtureRoot(full = false) {
  const disk = await statfs(tmpdir()); expect(disk.bavail * disk.bsize).toBeGreaterThan(256 * 1024 * 1024 + 6 * 1024 * 1024)
  const root = await mkdtemp(join(tmpdir(), 'morpho-idle-history-test-')); temporary.push(root)
  const native = join(root, profile.history.nativeDirectory), companion = join(root, profile.history.companionDirectory)
  if (full) {
    await mkdir(join(root, 'data/research/venue-signals'), { recursive: true, mode: 0o700 })
    await cp(join(process.cwd(), profile.history.nativeDirectory), native, { recursive: true, errorOnExist: true, force: false })
    await cp(join(process.cwd(), profile.history.companionDirectory), companion, { recursive: true, errorOnExist: true, force: false })
  } else {
    await mkdir(native, { recursive: true, mode: 0o700 }); await mkdir(companion, { recursive: true, mode: 0o700 })
    await writeFile(join(native, 'terminal.json'), archive.nativeFiles['terminal.json'], { mode: 0o600, flag: 'wx' })
    await writeFile(join(companion, 'manifest.json'), archive.companionManifestText, { mode: 0o600, flag: 'wx' })
  }
  return { root, native, companion }
}
describe('separate zero-adapter idle native history', () => {
  it('selects only the exact idle tuple and rejects profile clones', () => {
    expect(isAppOwnedMorphoV2IdleTrustedProfile(profile)).toBe(true)
    expect(isAppOwnedMorphoV2IdleTrustedProfile(structuredClone(profile))).toBe(false)
    expect(resolveMorphoV2IdleTrustedProfile(profile.identity.routeKey, '0xbeef00b5d83c1188f07a5184230a805639c39f04', profile.identity.asset)).toBeNull()
    expect(resolveMorphoV2IdleTrustedProfile(profile.identity.routeKey, profile.identity.destination.toUpperCase(), profile.identity.asset)).toBeNull()
    expect(() => replayMorphoV2IdleNativeHistory(structuredClone(profile) as MorphoV2IdleTrustedProfile, archive)).toThrow(/profile_identity/)
  })
  it('replays the real original corpus without granting live or execution authority', () => {
    expect(isOriginalMorphoV2IdleNativeHistory(history, profile)).toBe(true)
    expect(history.provenance).toMatchObject({ nativeFiles: 109, nativeBytes: 2335675, physicalStarts: 98, sourcePins: 46, inputPins: 6,
      reportedAvailableAtUtc: '2026-10-10T05:29:43.242Z', verifiedReplayCompletedAtUtc: '2026-10-10T05:30:32.512Z' })
    expect(history.capturedCurrent.historicalReferenceOnly).toBe(true)
    expect(history.capturedCurrent.observation.historicalPoint.fixedCurrentStockConversion.assetsRaw).toBe('714000')
    expect(history.anchors.map((x) => x.idleCashRaw)).toEqual(['20919825104652', '24375516077801'])
    expect(history.anchors.map((x) => x.fixedCurrentStockConversion.assetsRaw)).toEqual(['713612', '713661'])
    expect(history.claims).toMatchObject({ currentWalletControl: false, historicalOwnership: false, historicalOwnedEntitlementMeasured: false,
      holderExecutableExit: false, sourceImplementationEquivalence: false, calibrated: false, coveragePromotion: false, MRaw: null })
  })
  it('denies summary and JSON clones even when approval flags are added', () => {
    const clone = { ...JSON.parse(JSON.stringify(history)), profileApproval: true, authenticated: true }
    expect(isOriginalMorphoV2IdleNativeHistory(clone)).toBe(false)
    expect(() => selectMorphoV2IdleHistoryForStock(clone as MorphoV2IdleNativeHistory, profile.history.captureOwner, history.captureSharesRaw)).toThrow(/history_owner/)
    expect(() => morphoV2IdleHistoricalPreviewDescriptors(structuredClone(history), history.captureSharesRaw)).toThrow(/history_identity/)
  })
  it('reuses only the exact fixed stock and returns exact new-stock calldata otherwise', () => {
    expect(selectMorphoV2IdleHistoryForStock(history, profile.history.captureOwner, history.captureSharesRaw).status).toBe('matched')
    const changed = (BigInt(history.captureSharesRaw) + 37n).toString()
    const selection = selectMorphoV2IdleHistoryForStock(history, profile.history.captureOwner, changed)
    expect(selection.status).toBe('stock_mismatch'); expect(selection.points).toBeNull()
    for (const descriptor of selection.descriptors) {
      expect(descriptor.sharesRaw).toBe(changed)
      expect(BigInt('0x' + descriptor.params[0].data.slice(10)).toString()).toBe(changed)
      expect(descriptor.params[1]).toEqual({ blockHash: descriptor.source.blockHash, requireCanonical: true })
    }
    expect(selection.descriptors.map((x) => x.source)).toEqual(profile.history.anchors)
    expect(() => morphoV2IdlePreviewRedeemCalldata('0')).toThrow(/shares/)
    expect(() => morphoV2IdlePreviewRedeemCalldata((1n << 256n).toString())).toThrow(/shares/)
  })
  it('does not attribute the captured owner historical stock to another wallet', () => {
    const owner = '0x1111111111111111111111111111111111111111'
    const selection = selectMorphoV2IdleHistoryForStock(history, owner, history.captureSharesRaw)
    expect(selection.status).toBe('matched')
    expect(selection.points!.every((x) => x.owner === owner && x.historicalOwnerSharesRaw === null)).toBe(true)
    expect(history.anchors.every((x) => x.owner === profile.history.captureOwner)).toBe(true)
  })
  it('keeps cash, total assets and full-stock conversion distinct', () => {
    const decoded = decodeMorphoV2IdleNativePoint(profile, pointInput())
    expect(decoded.historicalPoint.idleCashRaw).toBe('39678091697943')
    expect(decoded.totalAssetsRaw).toBe('409127963880079')
    expect(decoded.historicalPoint.fixedCurrentStockConversion.assetsRaw).toBe('714000')
    expect(decoded.historicalOwnedEntitlementAssetRaw).toBeNull()
    expect(decoded.historicalPoint.regime).toMatchObject({ kind: 'zero_adapter_idle', liquidityAdapter: profile.configured.liquidityAdapter, liquidityData: '0x' })
  })
  it.each(['vault_code', 'asset_decimals', 'liquidity_adapter', 'liquidity_data'])('rejects coherent paired %s drift semantically', (key) => {
    const input = pointInput()
    for (const trace of input.traces.filter((x) => x.key === 'current:' + key)) {
      trace.envelope.result = key === 'vault_code' ? '0x00' : key === 'liquidity_data' ? '0x' : '0x' + (key === 'asset_decimals' ? '12' : '1').padStart(64, '0')
    }
    expect(() => decodeMorphoV2IdleNativePoint(profile, input)).toThrow(/runtime|units_asset|idle_regime/)
  })
  it('rejects provider disagreement, changed source hash and incorrect stock calldata', () => {
    let input = pointInput(); input.traces.find((x) => x.key === 'current:idle_cash')!.envelope.result = '0x' + '1'.padStart(64, '0')
    expect(() => decodeMorphoV2IdleNativePoint(profile, input)).toThrow(/provider_disagreement/)
    input = pointInput(); input.source = { ...input.source, blockHash: '0x' + '1'.repeat(64) }
    expect(() => decodeMorphoV2IdleNativePoint(profile, input)).toThrow(/header|point_request/)
    input = pointInput(); input.probeSharesRaw = '1000000000000000000'
    expect(() => decodeMorphoV2IdleNativePoint(profile, input)).toThrow(/point_request/)
  })
  it('refuses accessor-bearing point data before invoking the getter', () => {
    const input = pointInput(); let called = 0
    Object.defineProperty(input, 'owner', { get() { called++; return profile.history.captureOwner }, enumerable: true })
    expect(() => decodeMorphoV2IdleNativePoint(profile, input)).toThrow(/point_input/); expect(called).toBe(0)
  })
  it('rejects byte tampering, duplicate keys and row removal from the pinned proof', () => {
    const original = archive.nativeFiles['native-row-001.json']
    expect(() => replayMorphoV2IdleNativeHistory(profile, nativeChange('native-row-001.json', original.replace('success', 'failure')))).toThrow(/native_file_pin/)
    expect(() => replayMorphoV2IdleNativeHistory(profile, nativeChange('native-row-001.json', original.replace('{', '{"schema":"injected",')))).toThrow(/native_file_pin/)
    const { 'native-row-001.json': removed, ...remaining } = archive.nativeFiles
    expect(removed).toBeDefined(); expect(() => replayMorphoV2IdleNativeHistory(profile, { ...archive, nativeFiles: remaining })).toThrow(/archive_closed_set/)
  })
  it('rejects original-source companion changes instead of trusting approval metadata', () => {
    const name = Object.keys(archive.companionFiles).find((x) => x.startsWith('original-00-'))!
    expect(() => replayMorphoV2IdleNativeHistory(profile, { ...archive, companionFiles: { ...archive.companionFiles, [name]: archive.companionFiles[name] + '\n' } })).toThrow(/archived_original_pin/)
    expect(() => replayMorphoV2IdleNativeHistory(profile, { ...archive, companionManifestText: JSON.stringify({ ...JSON.parse(archive.companionManifestText), profileApproval: true }) })).toThrow(/file_hash/)
  })
  it('loads from immutable copies even when the fixture working producer has changed', async () => {
    const fixture = await fixtureRoot(true)
    await mkdir(join(fixture.root, 'scripts/research'), { recursive: true, mode: 0o700 })
    await writeFile(join(fixture.root, 'scripts/research/pyusd-b576-idle-history-capture-v2.mjs'), 'changed working source\n', { mode: 0o600, flag: 'wx' })
    const replayed = await loadMorphoV2IdleHistory(profile, { rootDirectory: fixture.root })
    expect(isOriginalMorphoV2IdleNativeHistory(replayed)).toBe(true)
    expect(replayed.anchors).toEqual(history.anchors)
  })
  it('rejects a nonprivate file and symlink without reading outside the closed directory', async () => {
    let fixture = await fixtureRoot()
    await chmod(join(fixture.native, 'terminal.json'), 0o644)
    await expect(loadMorphoV2IdleHistory(profile, { rootDirectory: fixture.root })).rejects.toThrow(/private_file/)
    fixture = await fixtureRoot()
    const original = join(fixture.native, 'terminal.json'), target = join(fixture.root, 'private-copy.json')
    await copyFile(original, target); await rm(original); await symlink(target, original)
    await expect(loadMorphoV2IdleHistory(profile, { rootDirectory: fixture.root })).rejects.toThrow(/private_file/)
  })
})
