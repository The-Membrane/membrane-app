import { spawnSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { INDEXABLE_PATHS } from '@/pages/sitemap.xml'

// Owner Q4 (2026-10-10): the weekly cron lives on `main` as .github/workflows/carry-scan.yml.
// This branch carries the file for review; these checks pin what the owner asked for.
// The scheduled run checks out the scan ref, which may not carry the workflow file itself (it
// lives on `main`): skip there rather than fail gate 5.
const ymlPath = join(__dirname, '..', '..', '.github', 'workflows', 'carry-scan.yml')
const yml = existsSync(ymlPath) ? readFileSync(ymlPath, 'utf8') : ''

describe.skipIf(!yml)('.github/workflows/carry-scan.yml', () => {
  it('runs weekly at 06:17 UTC on Monday and on manual dispatch with ref and accept_churn', () => {
    expect(yml).toContain('cron: "17 6 * * 1"')
    expect(yml).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+ref:/)
    expect(yml).toMatch(/accept_churn:\n(\s+.*\n)*?\s+type: boolean/)
  })

  it('checks out the scan code at inputs.ref || vars.CARRY_SCAN_REF || evm-migration', () => {
    expect(yml).toContain("${{ inputs.ref || vars.CARRY_SCAN_REF || 'evm-migration' }}")
  })

  it('has write permission, a concurrency group and a timeout', () => {
    expect(yml).toMatch(/permissions:\n\s+contents: write/)
    expect(yml).toMatch(/concurrency:\n\s+group: carry-scan/)
    expect(yml).toMatch(/timeout-minutes: 30/)
  })

  it('uses only the NET_APY_RPC_URL secret, masks every URL in it, and pushes to the data branch', () => {
    const secrets = [...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1])
    expect(new Set(secrets)).toEqual(new Set(['NET_APY_RPC_URL']))
    expect(yml).toContain('echo "::add-mask::$u"')
    expect(yml).toContain('push -q origin HEAD:data')
    expect(yml).toContain('--orphan data')
    expect(yml).toContain('"deploymentEnabled":false')
  })

  // Two jobs: `scan` runs pnpm install (third-party install scripts) and the scan with a
  // read-only token; `publish` holds the write token and runs no repo or dependency code.
  const jobsAt = yml.indexOf('\njobs:')
  const scanJob = yml.slice(yml.indexOf('\n  scan:\n'), yml.indexOf('\n  publish:\n'))
  const publishJob = yml.slice(yml.indexOf('\n  publish:\n'))

  it('the job that installs dependencies can only read; only the publish job can push', () => {
    expect(yml.slice(0, jobsAt)).toMatch(/permissions:\n\s+contents: read/)
    expect(scanJob).toMatch(/permissions:\n\s+contents: read/)
    expect(scanJob).toContain('pnpm install --frozen-lockfile')
    expect(publishJob).toMatch(/permissions:\n\s+contents: write/)
    expect(publishJob).not.toMatch(/\bpnpm\b|\bnpx\b|\btsx\b|npm (ci|install)|setup-node/)
    // The token never lands in a remote URL or .git/config: per-command header only.
    expect(yml).not.toMatch(/https:\/\/x-access-token/)
    expect(publishJob).toContain('http.extraheader')
  })

  it('every failure leaves a status.json, including checkout, setup and install failures', () => {
    expect(scanJob).toMatch(/outputs:\n\s+reason: \$\{\{ steps\.why\.outputs\.reason \}\}/)
    expect(scanJob).toMatch(/id: why\n\s+if: failure\(\) && steps\.scan\.outcome == 'skipped'/)
    expect(publishJob).toMatch(/needs: scan\n\s+if: always\(\)/)
    expect(publishJob).toContain('needs.scan.outputs.reason')
    expect(publishJob).toContain('status.json')
  })

  it('a scan ref without the scan code fails with that reason, not as a unit-test failure', () => {
    const check = scanJob.indexOf('CARRY_SCAN_REF=feat/carry-scout')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(scanJob.indexOf('pnpm install --frozen-lockfile'))
    expect(scanJob).toContain('scripts/carry-scan/run.ts ]')
  })

  it('runs on a supported Node (20 is end-of-life)', () => {
    expect(yml).toMatch(/node-version: 22\n/)
  })

  it('runs the carryScan unit tests before the scan (gate 5)', () => {
    expect(yml.indexOf('pnpm test:unit tests/unit/carryScan')).toBeGreaterThan(0)
    expect(yml.indexOf('pnpm test:unit tests/unit/carryScan')).toBeLessThan(
      yml.indexOf('pnpm tsx scripts/carry-scan/run.ts'),
    )
  })
})

/**
 * The `run: |` script of the step named `name`, dedented. GitHub runs it as
 * `bash --noprofile --norc -eo pipefail`, which is how these tests run it.
 */
function stepScript(src: string, name: string): string {
  const lines = src.split('\n')
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`)
  if (at < 0) throw new Error(`no step named "${name}"`)
  let j = at + 1
  while (j < lines.length && !/^\s*run: \|\s*$/.test(lines[j])) {
    if (/^\s*- (name|uses):/.test(lines[j])) throw new Error(`step "${name}" has no run block`)
    j++
  }
  const runIndent = lines[j].search(/\S/)
  const body: string[] = []
  for (j++; j < lines.length; j++) {
    if (lines[j].trim() && lines[j].search(/\S/) <= runIndent) break
    body.push(lines[j])
  }
  const ind = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)))
  return body.map((l) => l.slice(ind)).join('\n')
}

const tmps: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'carry-scan-wf-'))
  tmps.push(d)
  return d
}
const put = (root: string, rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}
const bash = (script: string, cwd: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    // A bare environment: the step scripts see only what the workflow step would set.
    env: {
      NODE_ENV: 'test' as const,
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...env,
    },
    encoding: 'utf8',
  })

// The step scripts themselves, executed: a text check passes a step whose logic is disabled.
describe.skipIf(!yml)('carry-scan.yml step scripts, executed', () => {
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('a ref without the scan code stops before install, naming the ref and the fix', () => {
    const script = stepScript(yml, 'Check the scan code exists at the ref')
    const empty = tmp()
    const r = bash(script, empty, { SCAN_REF: 'evm-migration' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('no carry-scan code at ref evm-migration')
    expect(r.stdout).toContain('CARRY_SCAN_REF=feat/carry-scout')
    const runnerOnly = tmp()
    put(runnerOnly, 'scripts/carry-scan/run.ts', '')
    expect(bash(script, runnerOnly, { SCAN_REF: 'x' }).status).toBe(1)
    const full = tmp()
    put(full, 'scripts/carry-scan/run.ts', '')
    put(full, 'tests/unit/carryScanGate.test.ts', '')
    expect(bash(script, full, { SCAN_REF: 'x' }).status).toBe(0)
  })

  it('names the stage that stopped the scan job before the scan ran', () => {
    const script = stepScript(yml, 'Name the stage that failed')
    const reasonFor = (o: Record<string, string>) => {
      const d = tmp()
      const out = join(d, 'out')
      writeFileSync(out, '')
      const env = {
        SCAN_REF: 'gone-branch',
        GITHUB_OUTPUT: out,
        O_CHECKOUT: 'success',
        O_PRESENT: 'success',
        O_DATA: 'success',
        O_TESTS: 'skipped',
        ...o,
      }
      expect(bash(script, d, env).status).toBe(0)
      return readFileSync(out, 'utf8')
    }
    expect(reasonFor({ O_CHECKOUT: 'failure', O_PRESENT: 'skipped' })).toBe(
      'reason=workflow: scan code checkout failed at ref gone-branch\n',
    )
    expect(reasonFor({ O_PRESENT: 'failure' })).toContain('no carry-scan code at ref gone-branch')
    expect(reasonFor({ O_DATA: 'failure' })).toContain('could not read the data branch')
    expect(reasonFor({ O_TESTS: 'failure' })).toBe('reason=gate 5: carryScan unit tests failed\n')
    expect(reasonFor({})).toContain('dependency install failed before the scan')
  })

  it('with no scan result, writes a failed status.json that keeps the last good week', () => {
    const script = stepScript(yml, 'Merge the result, or record why there is none')
    const d = tmp()
    put(
      d,
      'data/carry-scan/status.json',
      JSON.stringify({ week: '2026-W41', ok: true, lastGoodWeek: '2026-W41' }),
    )
    put(d, 'data/carry-scan/latest.json', '{"week":"2026-W41"}')
    const r = bash(script, d, {
      GOT: 'failure',
      REASON: 'gate 5: carryScan unit tests failed',
      SCAN_RESULT: 'failure',
    })
    expect(r.status).toBe(0)
    const st = JSON.parse(readFileSync(join(d, 'data/carry-scan/status.json'), 'utf8'))
    expect(st).toMatchObject({
      ok: false,
      reason: 'gate 5: carryScan unit tests failed',
      week: '2026-W41',
      lastGoodWeek: '2026-W41',
    })
    expect(readFileSync(join(d, 'data/carry-scan/latest.json'), 'utf8')).toBe('{"week":"2026-W41"}')
    // A job that died without naming a stage still leaves a reason.
    const d2 = tmp()
    mkdirSync(join(d2, 'data/carry-scan'), { recursive: true })
    expect(bash(script, d2, { GOT: 'failure', REASON: '', SCAN_RESULT: 'cancelled' }).status).toBe(
      0,
    )
    const st2 = JSON.parse(readFileSync(join(d2, 'data/carry-scan/status.json'), 'utf8'))
    expect(st2).toMatchObject({ ok: false, lastGoodWeek: null })
    expect(st2.reason).toContain('cancelled')
  })

  // The scan job copies the data branch into data/carry-scan before the scan, so when the scan
  // step dies before writeOutcome (OOM kill, a broken import) the artifact still holds LAST
  // week's status.json. Copying it back is a no-op commit: no "Last scan failed" banner.
  it('a scan that died before writing its own status.json is recorded as a failure', () => {
    const script = stepScript(yml, 'Merge the result, or record why there is none')
    const d = tmp()
    const prev = JSON.stringify({
      lastAttempt: 1791693907,
      week: '2026-W41',
      ok: true,
      reason: null,
      lastGoodWeek: '2026-W41',
    })
    for (const root of ['data/carry-scan', 'result']) {
      put(d, `${root}/status.json`, prev)
      put(d, `${root}/latest.json`, '{"week":"2026-W41"}')
    }
    const r = bash(script, d, { GOT: 'success', REASON: '', SCAN_RESULT: 'failure' })
    expect(r.status).toBe(0)
    const st = JSON.parse(readFileSync(join(d, 'data/carry-scan/status.json'), 'utf8'))
    expect(st).toMatchObject({ ok: false, week: '2026-W41', lastGoodWeek: '2026-W41' })
    expect(st.reason).toContain('failure')
    expect(readFileSync(join(d, 'data/carry-scan/latest.json'), 'utf8')).toBe('{"week":"2026-W41"}')
    // A scan that ran writes a new status.json (lastAttempt moves), and that one is copied.
    const fresh = JSON.stringify({ ...JSON.parse(prev), lastAttempt: 1792298707, ok: false })
    put(d, 'result/status.json', fresh)
    expect(bash(script, d, { GOT: 'success', REASON: '', SCAN_RESULT: 'failure' }).status).toBe(0)
    expect(readFileSync(join(d, 'data/carry-scan/status.json'), 'utf8')).toBe(fresh)
  })

  it('copies only regular JSON files from the scan artifact, never symlinks or scripts', () => {
    const script = stepScript(yml, 'Merge the result, or record why there is none')
    const d = tmp()
    mkdirSync(join(d, 'data/carry-scan'), { recursive: true })
    put(d, 'result/status.json', '{"ok":true}')
    put(d, 'result/weeks/2026-W42.json', '{"week":"2026-W42"}')
    put(d, 'result/hook.sh', 'echo pwned')
    put(d, 'secret.txt', 'token')
    symlinkSync(join(d, 'secret.txt'), join(d, 'result/link.json'))
    expect(bash(script, d, { GOT: 'success', REASON: '', SCAN_RESULT: 'success' }).status).toBe(0)
    expect(readFileSync(join(d, 'data/carry-scan/status.json'), 'utf8')).toBe('{"ok":true}')
    expect(existsSync(join(d, 'data/carry-scan/weeks/2026-W42.json'))).toBe(true)
    expect(existsSync(join(d, 'data/carry-scan/hook.sh'))).toBe(false)
    expect(existsSync(join(d, 'data/carry-scan/link.json'))).toBe(false)
  })
})

describe('sitemap', () => {
  it('lists the carry scout page', () => {
    expect(INDEXABLE_PATHS.some((p) => p.endsWith('/carry-scout'))).toBe(true)
  })
})
