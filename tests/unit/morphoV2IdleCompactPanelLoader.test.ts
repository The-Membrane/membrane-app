import { afterEach, describe, expect, it } from 'vitest'
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MORPHO_V2_IDLE_COMPACT_PANEL_PIN } from '../../lib/carry/morphoV2IdleCompactPanelPin'
import { isOriginalMorphoV2IdleCompactPanel, loadMorphoV2IdleCompactPanel } from '../../lib/carry/morphoV2IdleCompactPanel.server'
import { resolveMorphoV2IdleTrustedProfile } from '../../lib/carry/morphoV2IdleTrustedProfiles'
import { panelTestText } from './morphoV2IdlePanelForecast.fixture'

const profile = resolveMorphoV2IdleTrustedProfile('PYUSD → VaultV2 [PYUSD]', '0xb576765fb15505433af24fee2c0325895c559fb2', '0x6c3ea9036406852006290770bedfcaba0e23a0e8')!
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (MORPHO_V2_IDLE_COMPACT_PANEL_PIN.relativePath) await chmod(dirname(join(root, MORPHO_V2_IDLE_COMPACT_PANEL_PIN.relativePath)), 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
async function checkout(fileMode = 0o644, directoryMode = 0o755) {
  const text = panelTestText(), relative = MORPHO_V2_IDLE_COMPACT_PANEL_PIN.relativePath!
  const root = await mkdtemp(join(tmpdir(), 'idle-public-panel-control-')); roots.push(root)
  const path = join(root, relative), parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o755 }); await writeFile(path, text, { flag: 'wx', mode: 0o600 })
  await chmod(path, fileMode); await chmod(parent, directoryMode)
  return { root, path, parent, text }
}
describe('fixed sanitized compact panel deployment loader', () => {
  it.each([[0o644, 0o755], [0o444, 0o555], [0o600, 0o700]])('loads exact pinned bytes with deployment modes %s/%s', async (file, directory) => {
    const f = await checkout(file, directory), value = await loadMorphoV2IdleCompactPanel(profile, { rootDirectory: f.root })
    expect(value).not.toBeNull(); expect(value!.text).toBe(f.text)
    expect(isOriginalMorphoV2IdleCompactPanel(value, profile)).toBe(true)
    expect(isOriginalMorphoV2IdleCompactPanel(structuredClone(value), profile)).toBe(false)
    expect(isOriginalMorphoV2IdleCompactPanel(value, structuredClone(profile))).toBe(false)
  })
  it.each(['world writable file', 'group writable directory', 'symlink', 'hardlink', 'digest tamper', 'parent alias'])('rejects %s without changing the pin', async kind => {
    const f = await checkout()
    if (kind === 'world writable file') await chmod(f.path, 0o646)
    if (kind === 'group writable directory') await chmod(f.parent, 0o775)
    if (kind === 'digest tamper') await writeFile(f.path, ' ' + f.text.slice(1))
    if (kind === 'hardlink') await link(f.path, join(f.root, 'second-link.json'))
    if (kind === 'symlink') { await rm(f.path); await writeFile(join(f.root, 'target.json'), f.text); await symlink(join(f.root, 'target.json'), f.path) }
    if (kind === 'parent alias') { const moved = join(f.root, 'actual-parent'); await mkdir(moved); await writeFile(join(moved, 'panel.json'), f.text); await rm(f.parent, { recursive: true }); await symlink(moved, f.parent) }
    expect(await loadMorphoV2IdleCompactPanel(profile, { rootDirectory: f.root })).toBeNull()
  })
  it('rejects a cloned profile before disk access and leaves unpinned deployment closed', async () => {
    expect(await loadMorphoV2IdleCompactPanel(structuredClone(profile), { rootDirectory: '/path-that-does-not-exist' })).toBeNull()
    if (MORPHO_V2_IDLE_COMPACT_PANEL_PIN.sha256 === null) expect(await loadMorphoV2IdleCompactPanel(profile)).toBeNull()
  })
})
