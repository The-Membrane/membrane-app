import { spawnSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  collectorNote,
  collectorOf,
  parseAttempts,
  snapshot,
  stalestFirst,
  subjectCounts,
  summarize,
} from '../../scripts/oracle-registry/config/counts.mjs'

// Owner 2026-10-11: "move the re-collect to GitHub Actions". The workflow lives on `main` as
// .github/workflows/oracle-config-collect.yml; the scan branch carries a copy for review, and
// these checks pin it. A ref without the file skips them (the scheduled run checks out the scan
// ref, which may not carry it).
const REPO = join(__dirname, '..', '..')
const ymlPath = join(REPO, '.github', 'workflows', 'oracle-config-collect.yml')
const yml = existsSync(ymlPath) ? readFileSync(ymlPath, 'utf8') : ''
const COUNTS = join(REPO, 'scripts', 'oracle-registry', 'config', 'counts.mjs')
const CONFIG = 'data/oracle-registry/config'

const collectJob = yml.slice(yml.indexOf('\n  collect:\n'), yml.indexOf('\n  publish:\n'))
const publishJob = yml.slice(yml.indexOf('\n  publish:\n'))

/** Every `run:` script of the workflow (block scalars dedented, inline values as they are). */
function runScripts(src: string): string[] {
  const lines = src.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: (.*)$/.exec(lines[i])
    if (!m) continue
    if (m[2].trim() !== '|') {
      out.push(m[2])
      continue
    }
    const runIndent = lines[i].search(/\S/)
    const body: string[] = []
    for (i++; i < lines.length; i++) {
      if (lines[i].trim() && lines[i].search(/\S/) <= runIndent) break
      body.push(lines[i])
    }
    i--
    out.push(body.join('\n'))
  }
  return out
}

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
  const d = mkdtempSync(join(tmpdir(), 'oracle-config-wf-'))
  tmps.push(d)
  return d
}
const put = (root: string, rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}
// git, isolated from the user's own config (signing, hooks, default branch)
const GIT_ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const GIT_ENV = {
  ...GIT_ISOLATED,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const bash = (script: string, cwd: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    // A bare environment: the step scripts see only what the workflow step would set.
    env: {
      NODE_ENV: 'test' as const,
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...GIT_ISOLATED,
      ...env,
    },
    encoding: 'utf8',
  })
const outputs = (file: string) => {
  const o: Record<string, string> = {}
  const t = readFileSync(file, 'utf8')
  for (const m of t.matchAll(/^(\w+)<<(\w+)\n([\s\S]*?)\n\2$/gm)) o[m[1]] = m[3]
  for (const m of t.matchAll(/^(\w+)=(.*)$/gm)) o[m[1]] = m[2]
  return o
}

const SUBJECTS = 'wbtc rseth wsteth usde susde weeth pt-srusde cbbtc'

describe.skipIf(!yml)('.github/workflows/oracle-config-collect.yml', () => {
  it('runs daily at 05:41 UTC and on dispatch with subjects and ref inputs', () => {
    expect(yml).toContain('cron: "41 5 * * *"')
    expect(yml).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+subjects:/)
    expect(yml).toContain(`default: "${SUBJECTS}"`)
    expect(yml).toMatch(/ref:\n(\s+.*\n)*?\s+default: ""\n/)
  })

  it('the default subject list is every subject in subjects.json, the same on a schedule', () => {
    const subjects = JSON.parse(readFileSync(join(REPO, CONFIG, 'subjects.json'), 'utf8'))
      .subjects as { key: string }[]
    expect(new Set(SUBJECTS.split(' '))).toEqual(new Set(subjects.map((s) => s.key)))
    expect(collectJob).toContain(`SUBJECTS_IN: \${{ inputs.subjects || '${SUBJECTS}' }}`)
  })

  it('resolves the ref through env once, in collect; publish pushes to the ref collect ran from', () => {
    const ref = "SCAN_REF: ${{ inputs.ref || vars.ORACLE_REGISTRY_REF || 'feat/oracle-registry' }}"
    expect(collectJob).toContain(ref)
    expect(collectJob).toContain('ref: ${{ env.SCAN_REF }}')
    expect(collectJob).toContain('ref: ${{ steps.present.outputs.ref }}')
    // a variable changed between the jobs must not send branch A's data to branch B
    expect(publishJob).toContain('SCAN_REF: ${{ needs.collect.outputs.ref }}')
    expect(publishJob).not.toMatch(/vars\.|inputs\.(?!allow_gap_jump\b)/)
    // the one input publish reads is the gap-jump override, through env, in its guard step
    expect(publishJob.match(/inputs\./g)).toHaveLength(1)
    const scripts = runScripts(yml)
    expect(scripts.length).toBeGreaterThan(10)
    for (const s of scripts) expect(s).not.toContain('${{')
  })

  it('masks every RPC URL before any other step; only collect steps see the secret, via env', () => {
    const steps = collectJob.slice(collectJob.indexOf('    steps:\n'))
    expect(steps).toMatch(/^ {4}steps:\n {6}- name: Mask RPC URLs\n/)
    const secretLines = yml.split('\n').filter((l) => l.includes('secrets.'))
    expect(secretLines.length).toBeGreaterThan(0)
    for (const l of secretLines)
      expect(l).toMatch(/^ {10}RECORDER_RPC_URL: \$\{\{ secrets\.RECORDER_RPC_URL \}\}$/)
    expect(yml.indexOf('secrets.')).toBeGreaterThan(yml.indexOf('- name: Mask RPC URLs'))
    expect(publishJob).not.toContain('secrets.')
    expect(stepScript(yml, 'Mask RPC URLs')).toContain('echo "::add-mask::$u"')
  })

  it('the collect job can only read; the publish job can push and runs no repo or dependency code', () => {
    expect(yml.slice(0, yml.indexOf('\njobs:'))).toMatch(/permissions:\n\s+contents: read\n/)
    expect(collectJob).toMatch(/permissions:\n\s+contents: read\n/)
    expect(collectJob).not.toMatch(/contents: write/)
    expect(collectJob).toContain('pnpm install --frozen-lockfile')
    expect(collectJob).toContain('persist-credentials: false')
    expect(publishJob).toMatch(/permissions:\n\s+contents: write\n/)
    expect(publishJob).not.toMatch(
      /\bpnpm\b|\bnpx\b|\btsx\b|\bnode\b|npm (ci|install)|setup-node|actions\/checkout|scripts\//,
    )
    // The token never lands in a remote URL or .git/config: a per-command header only.
    expect(yml).not.toMatch(/x-access-token@|https:\/\/x-access-token/)
    expect(publishJob).toContain('http.extraheader')
    expect(publishJob).toMatch(
      /needs: collect\n\s+if: \$\{\{ !cancelled\(\) && needs\.collect\.outputs\.uploaded == 'true' \}\}/,
    )
  })

  it('runs the config unit tests before the collector and the Kelp backtest after it, before the upload', () => {
    const at = (s: string) => {
      const i = collectJob.indexOf(s)
      expect(i, s).toBeGreaterThan(0)
      return i
    }
    const tests = at('pnpm test:unit tests/unit/oracleRegistryConfig')
    const collect = at('scripts/oracle-registry/config/collect-config.mjs --only=')
    const backtest = at('node scripts/oracle-registry/config/backtest-kelp.mjs')
    const upload = at('uses: actions/upload-artifact@v4')
    expect(tests).toBeLessThan(collect)
    expect(collect).toBeLessThan(backtest)
    expect(backtest).toBeLessThan(upload)
    expect(stepScript(yml, 'Kelp backtest (offline, byte-identical)')).toContain(
      'git diff --exit-code --stat -- "$CONFIG/backtest"',
    )
    expect(collectJob).toContain("steps.backtest.outcome == 'success'")
    expect(yml).not.toContain('--build-fixture')
  })

  it('runs one subject per process with a 4 GB heap, least recently tried first', () => {
    const s = stepScript(yml, 'Collect, one subject per process')
    expect(s).toMatch(/for s in \$SUBJECTS; do/)
    const step = collectJob.slice(collectJob.indexOf('- name: Collect, one subject per process'))
    expect(step.slice(0, step.indexOf('run: |'))).toContain(
      'SUBJECTS: ${{ steps.order.outputs.list }}',
    )
    expect(
      collectJob.indexOf('- name: Order the subjects, least recently tried first'),
    ).toBeLessThan(collectJob.indexOf('- name: Collect, one subject per process'))
    expect(s).toContain(
      'node --max-old-space-size=4096 scripts/oracle-registry/config/collect-config.mjs --only="$s" || rc=$?',
    )
    expect(yml.match(/collect-config\.mjs --/g)).toHaveLength(1)
    expect(yml).not.toMatch(/--only="?\$SUBJECTS|--only=\$\{/)
  })

  it('never force-pushes: a race is rebased and retried', () => {
    expect(yml).not.toMatch(/--force|push[^\n]*\s-f\b|push[^\n]*\s\+|--force-with-lease/)
    const s = stepScript(yml, 'Commit and push to the scan branch')
    expect(s).toContain('push -q origin "HEAD:refs/heads/$SCAN_REF"')
    expect(s).toContain('git rebase -q FETCH_HEAD')
  })

  it('keeps .cache through actions/cache (saved per run, restored from the newest save of any run) and out of the artifact', () => {
    const key =
      'key: oracle-config-cache-${{ steps.subjects.outputs.key }}-${{ github.run_id }}-${{ github.run_attempt }}'
    expect(collectJob).toContain('uses: actions/cache/restore@v4')
    expect(collectJob).toContain('uses: actions/cache/save@v4')
    expect(collectJob.split(key)).toHaveLength(3)
    // First CI run (2026-10-11): the scan caches accumulate, so the restore must take the NEWEST
    // save, whatever subject set made it. A prefix restores its most recently created match; a
    // subject-set prefix first would prefer an older full-set save to a newer subset save.
    expect(collectJob).toMatch(/restore-keys: \|\n\s+oracle-config-cache-\n\s+- name: /)
    expect(collectJob.match(/oracle-config-cache-/g)).toHaveLength(3)
    expect(collectJob).toContain('!app/data/oracle-registry/config/.cache')
    expect(collectJob).toMatch(
      /if: \$\{\{ !cancelled\(\) && steps\.leak\.outcome == 'success' \}\}\n\s+uses: actions\/cache\/save@v4/,
    )
  })

  it('has a concurrency group, a 350-minute timeout and Node 22', () => {
    expect(yml).toMatch(
      /concurrency:\n\s+group: oracle-config-collect\n\s+cancel-in-progress: false/,
    )
    expect(collectJob).toMatch(/timeout-minutes: 350\n/)
    expect(yml).toMatch(/node-version: 22\n/)
  })

  it('fails the run red when a subject failed, after the others were uploaded', () => {
    const fail = collectJob.indexOf('- name: Fail the run if a subject failed')
    expect(fail).toBeGreaterThan(collectJob.indexOf('- name: Upload the collected files'))
    expect(stepScript(yml, 'Fail the run if a subject failed')).toMatch(/\nexit 1\s*$/)
  })
})

// The step scripts themselves, executed: a text check passes a step whose logic is disabled.
describe.skipIf(!yml)('oracle-config-collect.yml step scripts, executed', () => {
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const KEY_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9'
  const KEY_B = '0123456789abcdef0123456789abcdef'
  const URL_A = `https://rpc.example.com/eth/${KEY_A}`
  const URL_B = `https://mainnet.example.io/v3/${KEY_B}`
  const PUBLIC = 'https://eth.public.example'

  it('masks every URL and every key in the secret, and prints neither', () => {
    const script = stepScript(yml, 'Mask RPC URLs')
    const r = bash(script, tmp(), { RECORDER_RPC_URL: ` ${URL_A}, ${URL_B}\n${PUBLIC},` })
    expect(r.status).toBe(0)
    const masked = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('::add-mask::'))
      .map((l) => l.slice('::add-mask::'.length))
    for (const v of [URL_A, URL_B, PUBLIC, KEY_A, KEY_B]) expect(masked).toContain(v)
    expect(masked).not.toContain('eth')
    expect(masked).not.toContain('v3')
    const rest = r.stdout.split('\n').filter((l) => !l.startsWith('::add-mask::'))
    expect(rest.join('\n')).not.toMatch(/example|[0-9a-f]{20}/)
    // readEnv() strips quotes around the value: the bare URLs and keys the collector uses are
    // masked however the secret was pasted
    for (const quoted of [`"${URL_A},${URL_B}"`, `'${URL_A}', "${URL_B}"`]) {
      const q = bash(script, tmp(), { RECORDER_RPC_URL: quoted })
      expect(q.status).toBe(0)
      const m = q.stdout
        .split('\n')
        .filter((l) => l.startsWith('::add-mask::'))
        .map((l) => l.slice('::add-mask::'.length))
      for (const v of [URL_A, URL_B, KEY_A, KEY_B]) expect(m, quoted).toContain(v)
      for (const v of m) expect(v, quoted).not.toMatch(/["']/)
    }
    for (const empty of ['', ' , ', '\n', '""', "' , '"]) {
      const e = bash(script, tmp(), { RECORDER_RPC_URL: empty })
      expect(e.status).toBe(1)
      expect(e.stdout).toContain('::error::the RECORDER_RPC_URL secret is not set')
    }
  })

  it('resolves the subject list: deduplicated, validated, with a sorted cache key', () => {
    const script = stepScript(yml, 'Resolve the subjects')
    const run = (SUBJECTS_IN: string) => {
      const d = tmp()
      const out = join(d, 'out')
      writeFileSync(out, '')
      const r = bash(script, d, { SUBJECTS_IN, GITHUB_OUTPUT: out })
      return { r, o: outputs(out) }
    }
    const ok = run('  wsteth rseth\twsteth pt-srusde ')
    expect(ok.r.status).toBe(0)
    expect(ok.o).toEqual({ list: 'wsteth rseth pt-srusde', key: 'pt-srusde+rseth+wsteth' })
    for (const bad of ['rseth;id', 'RSETH', '../x', '*']) {
      const b = run(`wbtc ${bad}`)
      expect(b.r.status, bad).toBe(1)
      expect(b.r.stdout).toContain('::error::not a subject key')
    }
    expect(run('   ').r.status).toBe(1)
  })

  it('runs the collector once per subject, continues past a failure, deletes the raw caches after each and KEEPS the scan caches', () => {
    const script = stepScript(yml, 'Collect, one subject per process')
    const d = tmp()
    const bin = join(d, 'bin')
    const log = join(d, 'node.log')
    const cache = join(d, CONFIG, '.cache')
    put(d, `${CONFIG}/.cache/controllers-at-v6.json`, '{}')
    put(d, `${CONFIG}/.cache/scan-1-from-last-run.jsonl`, '{"v":2,"confirmed":true}\n')
    // A fake `node`: records its arguments and what the previous subject left behind, writes the
    // caches a real run writes, and fails for the subject "usde".
    put(
      d,
      'bin/node',
      [
        '#!/bin/sh',
        `left=$(ls "${cache}" | grep -cE '^raw-|\\.tmp-' || true)`,
        `scans=$(ls "${cache}" | grep -c '^scan-' || true)`,
        'for a in "$@"; do case "$a" in --only=*) s="${a#--only=}";; esac; done',
        `echo "left=$left scans=$scans $*" >> "${log}"`,
        `touch "${cache}/scan-1-$s.jsonl" "${cache}/raw-$s.json" "${cache}/x.json.tmp-42"`,
        '[ "$s" = usde ] && exit 7',
        'exit 0',
      ].join('\n'),
    )
    spawnSync('chmod', ['+x', join(bin, 'node')])
    const runnerTemp = tmp()
    writeFileSync(join(runnerTemp, 'collected.txt'), '')
    const r = bash(script, d, {
      PATH: `${bin}:${process.env.PATH}`,
      SUBJECTS: 'wbtc usde rseth',
      CONFIG,
      RUNNER_TEMP: runnerTemp,
    })
    expect(r.status).toBe(0)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    // the raw caches of the previous subject are gone; its confirmed scan chunks are not (first
    // CI run 2026-10-11: they were deleted after every subject, so no run built on the last)
    expect(calls).toEqual([
      'left=0 scans=1 --max-old-space-size=4096 scripts/oracle-registry/config/collect-config.mjs --only=wbtc',
      'left=0 scans=2 --max-old-space-size=4096 scripts/oracle-registry/config/collect-config.mjs --only=usde',
      'left=0 scans=3 --max-old-space-size=4096 scripts/oracle-registry/config/collect-config.mjs --only=rseth',
    ])
    expect(readFileSync(join(runnerTemp, 'collected.txt'), 'utf8')).toBe(
      'wbtc ok\nusde failed\nrseth ok\n',
    )
    expect(r.stdout).toContain('::error::collect usde failed (exit 7)')
    expect(readdirSync(cache).sort()).toEqual([
      'attempts.txt',
      'controllers-at-v6.json',
      'scan-1-from-last-run.jsonl',
      'scan-1-rseth.jsonl',
      'scan-1-usde.jsonl',
      'scan-1-wbtc.jsonl',
    ])
    expect(readFileSync(join(cache, 'scan-1-from-last-run.jsonl'), 'utf8')).toBe(
      '{"v":2,"confirmed":true}\n',
    )
    // each start is recorded, so a subject that fails or times out goes to the back next run
    const tried = readFileSync(join(cache, 'attempts.txt'), 'utf8').trim().split('\n')
    expect(tried.map((l) => l.split(' ')[0])).toEqual(['wbtc', 'usde', 'rseth'])
    for (const l of tried) expect(l).toMatch(/^[a-z0-9-]+ \d{10}$/)
  })

  it('summarises before -> after, and a failed or timed-out subject keeps its committed files', () => {
    const d = tmp()
    const state = (red: number, block: number) =>
      JSON.stringify({
        asOf: { block },
        counts: { red, pending: 2, proposed: 0, floorBreaches: 0 },
        items: [{ key: 'x', breaches: [{ rule: 'r' }] }],
      })
    const rows = (n: number) =>
      JSON.stringify({
        changes: Array.from({ length: n }, () => ({ red: true, stillInEffect: true })),
      })
    for (const s of ['a', 'b']) {
      put(d, `${CONFIG}/state/${s}.json`, state(1, 100))
      put(d, `${CONFIG}/changes/${s}.json`, rows(1))
      put(d, `${CONFIG}/queues/${s}.json`, rows(0))
    }
    put(
      d,
      `${CONFIG}/cursors.json`,
      JSON.stringify({ bySubject: { a: { head: 100 }, b: { head: 100 } } }),
    )
    // the collector is committed with the files it wrote: before and after are the same code
    put(d, 'scripts/oracle-registry/config/.keep', '')
    symlinkSync(COUNTS, join(d, 'scripts/oracle-registry/config/counts.mjs'))
    git(d, 'init', '-q')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'seed')
    const runnerTemp = tmp()
    const env = { SUBJECTS: 'a b c', CONFIG, RUNNER_TEMP: runnerTemp }
    expect(bash(stepScript(yml, 'Count the committed files'), d, env).status).toBe(0)
    // a collected (one more red, a new head); b failed half-way; c timed out before it ran
    put(d, `${CONFIG}/state/a.json`, state(2, 200))
    put(d, `${CONFIG}/changes/a.json`, rows(2))
    put(
      d,
      `${CONFIG}/cursors.json`,
      JSON.stringify({ bySubject: { a: { head: 200 }, b: { head: 100 } } }),
    )
    put(d, `${CONFIG}/state/b.json`, state(9, 300))
    unlinkSync(join(d, `${CONFIG}/queues/b.json`))
    put(d, `${CONFIG}/state/c.json`, state(5, 300))
    writeFileSync(join(runnerTemp, 'collected.txt'), 'a ok\nb failed\n')
    const out = join(runnerTemp, 'out')
    writeFileSync(out, '')
    const r = bash(stepScript(yml, 'Summarise the run'), d, {
      ...env,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: join(runnerTemp, 'step-summary'),
    })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    // b is back to its committed bytes; c (never committed) is gone; a keeps the new files
    expect(git(d, 'diff', '--name-only', '--', CONFIG).split('\n').sort()).toEqual([
      `${CONFIG}/changes/a.json`,
      `${CONFIG}/cursors.json`,
      `${CONFIG}/state/a.json`,
    ])
    expect(git(d, 'ls-files', '--others', '--', CONFIG)).toBe('')
    expect(existsSync(join(d, `${CONFIG}/state/c.json`))).toBe(false)
    const o = outputs(out)
    expect(o.ok).toBe('a')
    expect(o.failed).toBe('b c')
    expect(o.head).toBe('200')
    expect(o.summary.split('\n')).toEqual([
      'a: red 1 -> 2, in-effect 1 -> 2, amber 2 -> 2, head-breach 1 -> 1, read-gap 0 -> 0, read-gap rows 0 -> 0 (head 100 -> 200)',
      'b: FAILED (committed files kept)',
      'c: FAILED (committed files kept)',
    ])
    expect(readFileSync(join(runnerTemp, 'step-summary'), 'utf8')).toContain('head=200')
  })

  it('refuses files that carry an RPC key, without printing it; a keyless public URL passes', () => {
    const script = stepScript(yml, 'Check no RPC URL or key is in the files')
    const d = tmp()
    put(d, `${CONFIG}/lz-metadata.json`, JSON.stringify({ rpcs: [PUBLIC] }))
    put(d, `${CONFIG}/.cache/ts-1.json`, '{}')
    const env = { CONFIG, RECORDER_RPC_URL: `${URL_A},${URL_B},${PUBLIC}` }
    const clean = bash(script, d, env)
    expect(clean.status).toBe(0)
    expect(clean.stdout).toContain('no RPC URL or key in data/oracle-registry/config')
    put(
      d,
      `${CONFIG}/.cache/verification.json`,
      JSON.stringify({ err: `HTTP 429 from ...${KEY_B}` }),
    )
    put(d, `${CONFIG}/state/a.json`, JSON.stringify({ warnings: [`read failed: ${URL_A}`] }))
    const dirty = bash(script, d, env)
    expect(dirty.status).toBe(1)
    expect(dirty.stdout).toContain(
      `::error::an RPC URL or key is in ${CONFIG}/.cache/verification.json`,
    )
    expect(dirty.stdout).toContain(`::error::an RPC URL or key is in ${CONFIG}/state/a.json`)
    expect(dirty.stdout + dirty.stderr).not.toContain(KEY_A)
    expect(dirty.stdout + dirty.stderr).not.toContain(KEY_B)
    expect(dirty.stdout).not.toContain('lz-metadata.json')
    // a quoted secret: the bare URLs and keys the collector used are still found
    for (const quoted of [`"${URL_A},${URL_B},${PUBLIC}"`, `'${URL_A}', "${URL_B}"`]) {
      const q = bash(script, d, { ...env, RECORDER_RPC_URL: quoted })
      expect(q.status, quoted).toBe(1)
      expect(q.stdout).toContain(
        `::error::an RPC URL or key is in ${CONFIG}/.cache/verification.json`,
      )
      expect(q.stdout).toContain(`::error::an RPC URL or key is in ${CONFIG}/state/a.json`)
      expect(q.stdout).not.toContain('lz-metadata.json')
    }
  })

  it('says when the before files were written by an OLDER collector (first CI run: round-8 files vs fail-closed code)', () => {
    const d = tmp()
    const state = (gaps: number) =>
      JSON.stringify({
        asOf: { block: 100 },
        counts: { red: 1, pending: 0, proposed: 0, floorBreaches: 0 },
        items: [],
        readGaps: Array.from({ length: gaps }, (_, i) => `gap ${i}`),
      })
    put(d, `${CONFIG}/state/a.json`, state(10))
    put(d, `${CONFIG}/state/b.json`, state(1))
    put(d, `${CONFIG}/cursors.json`, JSON.stringify({ bySubject: { a: { head: 100 } } }))
    put(d, 'lib/oracleRegistry/config/engine.ts', 'export const v = 8\n')
    put(d, 'scripts/oracle-registry/config/.keep', '')
    symlinkSync(COUNTS, join(d, 'scripts/oracle-registry/config/counts.mjs'))
    git(d, 'init', '-q')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'round 8: code and the files it wrote')
    const round8 = git(d, 'rev-parse', 'HEAD')
    // the fail-closed code lands WITHOUT a re-collect: the committed files are still round 8's
    put(d, 'lib/oracleRegistry/config/engine.ts', 'export const v = 9\n')
    git(d, 'commit', '-q', '-am', 'fail-closed audit (code only)')
    const runnerTemp = tmp()
    const env = { SUBJECTS: 'a b', CONFIG, RUNNER_TEMP: runnerTemp }
    const before = bash(stepScript(yml, 'Count the committed files'), d, env)
    expect(before.stderr).toBe('')
    expect(before.status).toBe(0)
    put(d, `${CONFIG}/state/a.json`, state(214))
    put(d, `${CONFIG}/state/b.json`, state(2))
    writeFileSync(join(runnerTemp, 'collected.txt'), 'a ok\nb ok\n')
    const out = join(runnerTemp, 'out')
    writeFileSync(out, '')
    const r = bash(stepScript(yml, 'Summarise the run'), d, {
      ...env,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: join(runnerTemp, 'step-summary'),
    })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const lines = outputs(out).summary.split('\n')
    expect(lines[0]).toMatch(
      new RegExp(
        `^a: .*read-gap 10 -> 214, .*\\(head 100 -> 100; before = older collector ${round8.slice(0, 8)}\\)$`,
      ),
    )
    expect(lines[1]).toContain(`before = older collector ${round8.slice(0, 8)}`)
    // control: the next run's before files ARE this code's — no note
    git(d, 'commit', '-q', '-am', 'data: re-collect a b')
    const again = bash(stepScript(yml, 'Count the committed files'), d, env)
    expect(again.status).toBe(0)
    put(d, `${CONFIG}/state/a.json`, state(215))
    writeFileSync(out, '')
    const r2 = bash(stepScript(yml, 'Summarise the run'), d, {
      ...env,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: join(runnerTemp, 'step-summary'),
    })
    expect(r2.status).toBe(0)
    expect(outputs(out).summary).not.toContain('collector')
  })

  // Review of lane E (2026-10-11, finding 2): the gate ran every oracleRegistryConfig* test on the
  // checked-out cards. Review11 pins values a person measured on them; the first CI run's cards
  // (d078fcf0, transport gaps) fail it — so every later run stopped at the gate, BEFORE the
  // collect that repairs the cards. The fake pnpm below fails exactly like that: on bot data.
  describe('the unit-test gate reads the cards as their last commit NOT written by this workflow left them', () => {
    const BOT = '41898282+github-actions[bot]@users.noreply.github.com'
    const gitAs = (cwd: string, email: string, ...args: string[]) => {
      const r = spawnSync('git', args, {
        cwd,
        env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email },
        encoding: 'utf8',
      })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
      return r.stdout.trim()
    }
    const gate = () => stepScript(yml, 'Config-card unit tests (gate)')
    const A_JSON = `${CONFIG}/state/a.json`
    const NEW_JSON = `${CONFIG}/state/new.json`
    // a fake pnpm: logs what the tests saw; fails on bot data (as Review11 does), or always (FAIL)
    const fakePnpm = () => {
      const bin = tmp()
      put(
        bin,
        'pnpm',
        [
          '#!/bin/sh',
          `printf 'args=%s\\n' "$*" >> "$LOG"`,
          `printf 'saw=%s\\n' "$(cat ${A_JSON})" >> "$LOG"`,
          `if [ -f ${NEW_JSON} ]; then echo new=present >> "$LOG"; else echo new=absent >> "$LOG"; fi`,
          `if [ -n "$DIRTY" ]; then echo x > ${CONFIG}/state/stray.json; fi`,
          'if [ -n "$FAIL" ]; then exit 1; fi',
          `grep -q human ${A_JSON}`,
        ].join('\n') + '\n',
      )
      spawnSync('chmod', ['+x', join(bin, 'pnpm')])
      return bin
    }
    // human: code + cards (h1) → bot: re-collected cards, one new file (b1) → human: code only (h2)
    const repo = (withBot = true) => {
      const d = tmp()
      put(d, 'README', 'code v1')
      put(d, A_JSON, '{"by":"human"}')
      put(d, `${CONFIG}/backtest/kelp.json`, '{"k":1}')
      git(d, 'init', '-q')
      git(d, 'add', '-A')
      git(d, 'commit', '-q', '-m', 'h1: code and the cards it was tested on')
      const h1 = git(d, 'rev-parse', 'HEAD')
      if (withBot) {
        put(d, A_JSON, '{"by":"bot"}')
        put(d, NEW_JSON, '{"by":"bot"}')
        gitAs(d, BOT, 'add', '-A')
        gitAs(d, BOT, 'commit', '-q', '-m', 'data(oracle-registry): re-collect a')
      }
      put(d, 'README', 'code v2')
      git(d, 'commit', '-q', '-am', 'h2: code only')
      return { d, h1 }
    }
    const run = (d: string, env: Record<string, string> = {}) => {
      const log = join(tmp(), 'log')
      writeFileSync(log, '')
      const r = bash(gate(), d, {
        CONFIG,
        LOG: log,
        PATH: `${fakePnpm()}:${process.env.PATH}`,
        ...env,
      })
      return { ...r, log: readFileSync(log, 'utf8') }
    }

    it('control: the plain test run on the checked-out cards fails on the bot data (the deadlock)', () => {
      const { d } = repo()
      const log = join(tmp(), 'log')
      const r = bash('pnpm test:unit tests/unit/oracleRegistryConfig', d, {
        LOG: log,
        PATH: `${fakePnpm()}:${process.env.PATH}`,
      })
      expect(r.status).toBe(1)
      expect(readFileSync(log, 'utf8')).toContain('saw={"by":"bot"}')
    })

    it('the tests see the cards of the last non-bot commit, pass, and the checked-out files are put back', () => {
      const { d, h1 } = repo()
      const r = run(d)
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
      expect(r.log.split('\n')).toEqual([
        'args=test:unit tests/unit/oracleRegistryConfig',
        'saw={"by":"human"}',
        'new=absent',
        '',
      ])
      expect(r.stdout).toContain(`as of ${h1}`)
      // put back: the collector and the carry read the branch's committed cards
      expect(readFileSync(join(d, A_JSON), 'utf8')).toBe('{"by":"bot"}')
      expect(existsSync(join(d, NEW_JSON))).toBe(true)
      expect(git(d, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    })

    it('a failing test still stops the run, with the files put back', () => {
      const { d } = repo()
      const r = run(d, { FAIL: '1' })
      expect(r.status).toBe(1)
      expect(r.log).toContain('saw={"by":"human"}')
      expect(readFileSync(join(d, A_JSON), 'utf8')).toBe('{"by":"bot"}')
      expect(git(d, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    })

    it('a test that leaves a file in the cards stops the run (nothing is collected on top of it)', () => {
      const { d } = repo()
      const r = run(d, { DIRTY: '1' })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain(
        `::error::${CONFIG} does not match the checked-out commit after the tests`,
      )
    })

    it('no bot commit: the tests read the checked-out cards, nothing is swapped', () => {
      const { d } = repo(false)
      const r = run(d)
      expect(r.status).toBe(0)
      expect(r.log).toContain('saw={"by":"human"}')
      expect(r.stdout).not.toContain('as of')
      expect(git(d, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    })
  })

  it('the leak check ignores case: a host or a key in another case is still found (it searched lowercase bytes)', () => {
    const script = stepScript(yml, 'Check no RPC URL or key is in the files')
    const ACCOUNT = 'frosty-quiet-meadow.ethereum-mainnet.quiknode.pro'
    const MIXED_KEY = 'AbCdEf0123456789XyZ0123456789q'
    const env = {
      CONFIG,
      RECORDER_RPC_URL: `https://${ACCOUNT}/,https://eth-mainnet.g.alchemy.com/v2/${MIXED_KEY}`,
    }
    const d = tmp()
    put(d, `${CONFIG}/state/a.json`, JSON.stringify({ readGaps: ['HTTP 429 from quiknode.pro'] }))
    expect(bash(script, d, env).status).toBe(0)
    put(
      d,
      `${CONFIG}/state/b.json`,
      JSON.stringify({ err: 'timeout at Frosty-Quiet-Meadow.Ethereum-Mainnet.QuikNode.pro' }),
    )
    // the engine lowercases what it keys on: a key can come back in lower case
    put(d, `${CONFIG}/changes/c.json`, JSON.stringify({ id: MIXED_KEY.toLowerCase() }))
    const r = bash(script, d, env)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(
      `::error::a full RPC host of the secret is in ${CONFIG}/state/b.json`,
    )
    expect(r.stdout).toContain(`::error::an RPC URL or key is in ${CONFIG}/changes/c.json`)
    expect(r.stdout).not.toContain('state/a.json')
    for (const v of [ACCOUNT, 'Frosty', MIXED_KEY, MIXED_KEY.toLowerCase()])
      expect(r.stdout + r.stderr).not.toContain(v)
  })

  it('refuses a file that names a FULL RPC host of the secret (a host label), without printing it; provider domains and LayerZero-listed hosts pass', () => {
    const script = stepScript(yml, 'Check no RPC URL or key is in the files')
    const ACCOUNT = 'frosty-quiet-meadow.ethereum-mainnet.quiknode.pro'
    const NODE = 'nd-123-456-789.p2pify.com'
    const LISTED = 'light-icy-dinghy.lens-mainnet.quiknode.pro'
    const QN_KEY = 'f00dfeed0123456789abcdef0123456789abcdef'
    const secretUrls = [
      `https://${ACCOUNT}/${QN_KEY}/`,
      `https://${NODE}/`,
      `https://${LISTED}/`,
      'https://rpc.ankr.com/eth/' + KEY_A,
      'https://mainnet.infura.io/v3/' + KEY_B,
      'https://1rpc.io/eth',
    ].join(',')
    const d = tmp()
    put(d, `${CONFIG}/lz-metadata.json`, JSON.stringify({ rpcs: ['https://rpc.ankr.com/eth'] }))
    put(d, `${CONFIG}/.cache/lz-metadata-raw.json`, JSON.stringify({ rpc: `https://${LISTED}/x` }))
    // what the collector writes: the provider's registrable domain only (rpc.mjs hostLabel), and
    // a host LayerZero lists publicly — both pass
    put(
      d,
      `${CONFIG}/state/a.json`,
      JSON.stringify({
        readGaps: [
          'admin event scan: blocks 1–2 not confirmed (HTTP 429 from infura.io, cross-check)',
          'scan: HTTP 503 from ankr.com; quiknode.pro; 1rpc.io; p2pify.com',
          `public: rpc.ankr.com, ${LISTED}`,
        ],
      }),
    )
    const env = { CONFIG, RECORDER_RPC_URL: secretUrls }
    const clean = bash(script, d, env)
    expect(clean.stdout + clean.stderr).not.toContain('::error::')
    expect(clean.status).toBe(0)
    // ACCOUNT, NODE and mainnet.infura.io; rpc.ankr.com and LISTED are listed, 1rpc.io is a domain
    expect(clean.stdout).toMatch(/\(\d+ strings and 3 hosts checked\)/)
    // a full host in a message (no key in it): refused, never printed
    put(
      d,
      `${CONFIG}/state/b.json`,
      JSON.stringify({ readGaps: [`HTTP request failed: ${ACCOUNT}`] }),
    )
    put(d, `${CONFIG}/.cache/scan-1-x.jsonl`, `{"error":"timeout at ${NODE}"}\n`)
    put(d, `${CONFIG}/queues/c.json`, JSON.stringify({ err: 'HTTP 429 from mainnet.infura.io' }))
    const dirty = bash(script, d, env)
    expect(dirty.status).toBe(1)
    for (const f of ['state/b.json', '.cache/scan-1-x.jsonl', 'queues/c.json'])
      expect(dirty.stdout).toContain(`::error::a full RPC host of the secret is in ${CONFIG}/${f}`)
    expect(dirty.stdout).not.toContain('state/a.json')
    expect(dirty.stdout).not.toContain('lz-metadata')
    for (const v of [ACCOUNT, NODE, 'frosty', 'nd-123', 'mainnet.infura', QN_KEY])
      expect(dirty.stdout + dirty.stderr).not.toContain(v)
    // the control: a host alone, no key anywhere — before this check it passed
    const hostOnly = bash(script, d, { CONFIG, RECORDER_RPC_URL: `https://${NODE}/` })
    expect(hostOnly.status).toBe(1)
  })

  describe('the publish guard: a jump in read gaps is not published', () => {
    const guard = () => stepScript(yml, 'Refuse a jump in read gaps')
    const st = (gaps: number | string) =>
      JSON.stringify({
        asOf: { block: 1 },
        ...(typeof gaps === 'number'
          ? { readGaps: Array.from({ length: gaps }, (_, i) => `g${i}`) }
          : { readGaps: gaps }),
      })
    // app/ is the branch at the collected commit (before); result/ is the artifact (after)
    const fixture = (pairs: Record<string, [number | string | null, number | string]>) => {
      const d = tmp()
      for (const [s, [b, a]] of Object.entries(pairs)) {
        if (b !== null) put(d, `app/${CONFIG}/state/${s}.json`, st(b))
        put(d, `result/state/${s}.json`, st(a))
      }
      put(d, 'result/cursors.json', '{}')
      return d
    }

    it('a transport-failure jump (10 -> 214) is red and publishes nothing; a modest rise (21 -> 35) passes', () => {
      const d = fixture({ wsteth: [21, 35], rseth: [10, 214], wbtc: [3, 3] })
      const r = bash(guard(), d, { ALLOW_GAP_JUMP: 'false' })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain(
        '::error::read gaps more than doubled and rose by more than 20: rseth (10 -> 214).',
      )
      expect(r.stdout).toContain('dispatch with allow_gap_jump=true')
      expect(r.stdout).not.toMatch(/::error::.*wsteth/)
      // the scheduled run: the variable is "false", or (outside Actions) not set at all
      expect(bash(guard(), d, {}).status).toBe(1)
    })

    it('a dispatch with allow_gap_jump=true publishes it, with a warning', () => {
      const d = fixture({ rseth: [10, 214] })
      const r = bash(guard(), d, { ALLOW_GAP_JUMP: 'true' })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('::warning::read gaps jumped: rseth (10 -> 214)')
    })

    it('both conditions: doubled but up by 20 or less, or up by more than 20 but not doubled, is published', () => {
      for (const [b, a] of [
        [0, 20],
        [5, 25],
        [30, 60],
        [100, 199],
        [214, 0],
      ] as const) {
        const r = bash(guard(), fixture({ s: [b, a] }), { ALLOW_GAP_JUMP: 'false' })
        expect(r.status, `${b} -> ${a}`).toBe(0)
        expect(r.stdout).toContain('no jump in read gaps')
      }
      for (const [b, a] of [
        [0, 21],
        [20, 41],
        [204, 409],
      ] as const)
        expect(bash(guard(), fixture({ s: [b, a] }), {}).status, `${b} -> ${a}`).toBe(1)
    })

    it('a first collection (no committed state) has no card to rewrite; no state key = 0 gaps', () => {
      expect(bash(guard(), fixture({ fresh: [null, 300] }), {}).status).toBe(0)
      const d = tmp()
      put(d, `app/${CONFIG}/state/s.json`, '{"asOf":{"block":1}}')
      put(d, 'result/state/s.json', st(21))
      expect(bash(guard(), d, {}).status).toBe(1)
    })

    it('fails closed: a malformed readGaps, an unparsable file, or no state in the artifact', () => {
      const bad = bash(guard(), fixture({ s: [1, 'not a list'] }), {})
      expect(bad.status).toBe(1)
      expect(bad.stdout).toContain('::error::the read gaps of s could not be counted')
      const d = fixture({ s: [1, 1] })
      put(d, 'result/state/s.json', '{"torn":')
      expect(bash(guard(), d, {}).status).toBe(1)
      // review nit (2026-10-11): a file of several JSON values counts as several lines, which
      // the integer test rejected as "no jump" — a 300-gap jump hidden behind a second value
      const multi = fixture({ s: [1, 1] })
      put(
        multi,
        'result/state/s.json',
        `${JSON.stringify({ readGaps: Array.from({ length: 300 }, (_, i) => `g${i}`) })}\n{}`,
      )
      const m = bash(guard(), multi, {})
      expect(m.status).toBe(1)
      expect(m.stdout).toContain('::error::the read gaps of s could not be counted')
      const none = tmp()
      put(none, 'result/cursors.json', '{}')
      const r = bash(guard(), none, {})
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('::error::the artifact has no state files')
    })

    it('runs in publish before anything is copied or committed; the override is a dispatch input only', () => {
      const at = (n: string) => publishJob.indexOf(`- name: ${n}`)
      expect(at('Refuse a jump in read gaps')).toBeGreaterThan(at('Download the collected files'))
      expect(at('Refuse a jump in read gaps')).toBeLessThan(
        at('Copy the collected JSON into place'),
      )
      expect(at('Copy the collected JSON into place')).toBeLessThan(
        at('Commit and push to the scan branch'),
      )
      expect(yml).toMatch(
        /allow_gap_jump:\n\s+description: .*\n\s+required: false\n\s+default: false\n\s+type: boolean\n/,
      )
      expect(publishJob).toContain(
        "ALLOW_GAP_JUMP: ${{ github.event_name == 'workflow_dispatch' && inputs.allow_gap_jump == true }}",
      )
      expect(guard()).toContain('if [ "$ALLOW_GAP_JUMP" = "true" ]; then')
      // jq only in publish: no repo or dependency code
      expect(guard()).not.toMatch(/\bnode\b|scripts\//)
    })
  })

  it('records the ref it checked out, for publish; a ref that is not a branch name is refused', () => {
    const script = stepScript(yml, 'Check the collector exists at the ref')
    const d = tmp()
    put(d, 'scripts/oracle-registry/config/collect-config.mjs', '')
    put(d, 'scripts/oracle-registry/config/counts.mjs', '')
    git(d, 'init', '-q')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'code')
    const run = (SCAN_REF: string) => {
      const out = join(tmp(), 'out')
      writeFileSync(out, '')
      return { r: bash(script, d, { SCAN_REF, GITHUB_OUTPUT: out, ...GIT_ENV }), out }
    }
    const ok = run('feat/x')
    expect(ok.r.status).toBe(0)
    expect(outputs(ok.out)).toEqual({ ref: 'feat/x', sha: git(d, 'rev-parse', 'HEAD') })
    for (const bad of ['feat/x\nsha=0000', 'a..b', 'with space', '']) {
      const b = run(bad)
      expect(b.r.status, JSON.stringify(bad)).toBe(1)
      expect(readFileSync(b.out, 'utf8'), JSON.stringify(bad)).toBe('')
    }
  })

  it('orders the subjects least recently collected or attempted first (never collected first)', () => {
    const script = stepScript(yml, 'Order the subjects, least recently tried first')
    const d = tmp()
    put(d, 'scripts/oracle-registry/config/.keep', '')
    symlinkSync(COUNTS, join(d, 'scripts/oracle-registry/config/counts.mjs'))
    const run = (SUBJECTS: string) => {
      const out = join(tmp(), 'out')
      writeFileSync(out, '')
      const r = bash(script, d, { SUBJECTS, CONFIG, GITHUB_OUTPUT: out })
      return { r, o: outputs(out) }
    }
    put(
      d,
      `${CONFIG}/cursors.json`,
      JSON.stringify({
        bySubject: {
          a: { runAt: '2026-10-10T04:00:00Z' },
          b: { runAt: '2026-10-10T01:00:00Z' },
          c: { runAt: '2026-10-10T02:00:00Z' },
        },
      }),
    )
    const r = run('a b c n')
    expect(r.r.status).toBe(0)
    expect(r.o).toEqual({ list: 'n b c a' })
    // b timed out at 05:00 and n was tried at 03:00: a subject that keeps failing (its runAt
    // never moves) goes to the back instead of taking every run's budget first
    const sec = (iso: string) => Date.parse(iso) / 1000
    put(
      d,
      `${CONFIG}/.cache/attempts.txt`,
      `b ${sec('2026-10-10T00:30:00Z')}\nn ${sec('2026-10-10T03:00:00Z')}\nb ${sec('2026-10-10T05:00:00Z')}\n`,
    )
    const tried = run('a b c n')
    expect(tried.r.status).toBe(0)
    expect(tried.o).toEqual({ list: 'c n a b' })
    // no readable cursors: the requested order, never a lost subject
    put(d, `${CONFIG}/cursors.json`, '{"torn":')
    const torn = run('a b c')
    expect(torn.r.status).toBe(0)
    expect(torn.o).toEqual({ list: 'a b c' })
    expect(torn.r.stdout).toContain('::warning::')
  })

  it('the summary judges only the subjects this run set out to collect, and every step runs with pipefail', () => {
    // a scheduled run takes PER_RUN subjects: the rest were never planned, so they are neither
    // "ok" nor FAILED (second review: summarising the full list failed every scheduled run)
    const at = yml.indexOf('- name: Summarise the run')
    const step = yml.slice(at, yml.indexOf('\n      - name:', at + 10))
    expect(step).toMatch(/\n {10}SUBJECTS: \$\{\{ steps\.order\.outputs\.list \}\}\n/)
    expect(step).not.toContain('steps.subjects.outputs.list')
    // GitHub's default without `shell:` is `bash -e {0}`; these tests run steps as -eo pipefail
    expect(yml).toMatch(/\ndefaults:\n {2}run:\n {4}shell: bash\n/)
  })

  it('a scheduled run takes only the PER_RUN stalest subjects; a dispatch takes all', () => {
    // A cold run of all 8 took ~29k paced cross-check requests (~8 h, over the 320-minute step
    // and the second endpoint's daily credits): the daily run rotates through the subjects
    // instead, stalest first, while the kept scan cache warms.
    const script = stepScript(yml, 'Order the subjects, least recently tried first')
    const d = tmp()
    put(d, 'scripts/oracle-registry/config/.keep', '')
    symlinkSync(COUNTS, join(d, 'scripts/oracle-registry/config/counts.mjs'))
    put(
      d,
      `${CONFIG}/cursors.json`,
      JSON.stringify({
        bySubject: {
          a: { runAt: '2026-10-10T04:00:00Z' },
          b: { runAt: '2026-10-10T01:00:00Z' },
          c: { runAt: '2026-10-10T02:00:00Z' },
        },
      }),
    )
    const run = (env: Record<string, string>) => {
      const out = join(tmp(), 'out')
      writeFileSync(out, '')
      const r = bash(script, d, { SUBJECTS: 'a b c n', CONFIG, GITHUB_OUTPUT: out, ...env })
      return { r, o: outputs(out) }
    }
    expect(run({ PER_RUN: '2' }).o).toEqual({ list: 'n b' })
    expect(run({ PER_RUN: '1' }).o).toEqual({ list: 'n' })
    expect(run({ PER_RUN: '9' }).o).toEqual({ list: 'n b c a' })
    expect(run({ PER_RUN: '' }).o).toEqual({ list: 'n b c a' })
    // a malformed cap never empties the run: it is ignored, with a warning
    for (const bad of ['0', '-1', 'two', '2 3', '$(id)']) {
      const r = run({ PER_RUN: bad })
      expect(r.r.status).toBe(0)
      expect(r.o).toEqual({ list: 'n b c a' })
      expect(r.r.stdout).toContain('::warning::')
    }
    // the cap is wired to the schedule event only, and passed through env
    const at = yml.indexOf('- name: Order the subjects, least recently tried first')
    const step = yml.slice(at, yml.indexOf('- name:', at + 10))
    expect(step).toMatch(
      /PER_RUN: \$\{\{ github\.event_name == 'schedule' && \(vars\.ORACLE_CONFIG_SUBJECTS_PER_RUN \|\| '2'\) \|\| '' \}\}/,
    )
  })

  const hasJq = spawnSync('jq', ['--version']).status === 0
  it.skipIf(!hasJq)(
    'copies only regular, parseable JSON files from the artifact, never .cache or symlinks',
    () => {
      const script = stepScript(yml, 'Copy the collected JSON into place')
      const d = tmp()
      mkdirSync(join(d, `app/${CONFIG}`), { recursive: true })
      put(d, 'result/state/a.json', '{"a":1}')
      put(d, 'result/cursors.json', '{"head":1}')
      put(d, 'result/.cache/controllers-at-v6.json', '{}')
      put(d, 'result/hook.sh', 'echo pwned')
      put(d, 'secret.txt', 'token')
      symlinkSync(join(d, 'secret.txt'), join(d, 'result/link.json'))
      const r = bash(script, d)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('copied 2 JSON files')
      expect(readFileSync(join(d, `app/${CONFIG}/state/a.json`), 'utf8')).toBe('{"a":1}')
      expect(existsSync(join(d, `app/${CONFIG}/cursors.json`))).toBe(true)
      for (const f of ['.cache/controllers-at-v6.json', 'hook.sh', 'link.json'])
        expect(existsSync(join(d, `app/${CONFIG}/${f}`)), f).toBe(false)
      put(d, 'result/state/b.json', '{"torn":')
      const bad = bash(script, d)
      expect(bad.status).toBe(1)
      expect(bad.stdout).toContain('::error::not JSON: ./state/b.json')
    },
  )

  describe('checkout and push against a local origin', () => {
    // https://github.com/<repo>.git is rewritten to a local bare repository for these runs.
    const setup = () => {
      const origin = join(tmp(), 'origin.git')
      git(tmpdir(), 'init', '-q', '--bare', origin)
      git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
      const seed = tmp()
      git(seed, 'init', '-q', '-b', 'feat/x')
      put(seed, `${CONFIG}/state/a.json`, '{"red":1}\n')
      put(seed, 'README', 'code\n')
      git(seed, 'add', '-A')
      git(seed, 'commit', '-q', '-m', 'code')
      git(seed, 'remote', 'add', 'origin', origin)
      git(seed, 'push', '-q', 'origin', 'feat/x')
      git(seed, 'tag', 'v1')
      git(seed, 'push', '-q', 'origin', 'v1')
      const sha = git(seed, 'rev-parse', 'HEAD')
      const runner = tmp()
      const bin = join(runner, 'bin')
      put(runner, 'bin/sleep', '#!/bin/sh\nexit 0\n')
      spawnSync('chmod', ['+x', join(bin, 'sleep')])
      const env = {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'org/repo',
        GH_TOKEN: 'ghs_faketoken',
        SCAN_REF: 'feat/x',
        SHA: sha,
        RUNNER_TEMP: runner,
        OK: 'a',
        HEAD_BLOCK: '26166851',
        SUMMARY: 'a: red 1 -> 2',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/org/repo.git',
      }
      const work = tmp()
      return { origin, seed, sha, env, work, app: join(work, 'app') }
    }
    const checkout = stepScript(yml, 'Check out the scan branch at the collected commit')
    const push = stepScript(yml, 'Commit and push to the scan branch')
    const race = (seed: string, file: string, body: string) => {
      put(seed, file, body)
      git(seed, 'add', '-A')
      git(seed, 'commit', '-q', '-m', 'upstream')
      git(seed, 'push', '-q', 'origin', 'feat/x')
      return git(seed, 'rev-parse', 'HEAD')
    }

    it('commits as github-actions[bot] with the summary and pushes to the branch', () => {
      const { origin, sha, env, work, app } = setup()
      expect(bash(checkout, work, env).status).toBe(0)
      expect(git(app, 'rev-parse', 'HEAD')).toBe(sha)
      expect(git(app, 'config', '--get-regexp', '.').toLowerCase()).not.toContain('token')
      put(app, `${CONFIG}/state/a.json`, '{"red":2}\n')
      const r = bash(push, app, env)
      expect(r.stderr).not.toContain('ghs_faketoken')
      expect(r.status).toBe(0)
      expect(git(origin, 'log', '-1', '--format=%an|%s|%P', 'feat/x')).toBe(
        `github-actions[bot]|data(oracle-registry): re-collect a @ block 26166851|${sha}`,
      )
      expect(git(origin, 'log', '-1', '--format=%b', 'feat/x')).toContain('a: red 1 -> 2')
      // nothing changed: nothing is committed
      expect(bash(push, app, env).stdout).toContain('nothing to commit')
    }, 30_000)

    it('a commit that landed after the collect is rebased onto, never overwritten', () => {
      const { origin, seed, env, work, app } = setup()
      expect(bash(checkout, work, env).status).toBe(0)
      const upstream = race(seed, 'README', 'code v2\n')
      put(app, `${CONFIG}/state/a.json`, '{"red":2}\n')
      const r = bash(push, app, env)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('push rejected (attempt 1): rebasing onto the branch tip')
      expect(git(origin, 'log', '-1', '--format=%P', 'feat/x')).toBe(upstream)
      expect(git(origin, 'show', 'feat/x:README')).toBe('code v2')
      expect(git(origin, 'show', `feat/x:${CONFIG}/state/a.json`)).toBe('{"red":2}')
    }, 30_000)

    it('a conflicting upstream change stops the run red and pushes nothing', () => {
      const { origin, seed, env, work, app } = setup()
      expect(bash(checkout, work, env).status).toBe(0)
      const upstream = race(seed, `${CONFIG}/state/a.json`, '{"red":7}\n')
      put(app, `${CONFIG}/state/a.json`, '{"red":2}\n')
      const r = bash(push, app, env)
      expect(r.status).toBe(1)
      expect(r.stdout).toContain(
        '::error::the re-collected files conflict with new commits on feat/x',
      )
      expect(git(origin, 'rev-parse', 'feat/x')).toBe(upstream)
    }, 30_000)

    it('a scan ref that is not a branch publishes nothing', () => {
      const { env, work } = setup()
      const r = bash(checkout, work, { ...env, SCAN_REF: 'v1' })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('::error::the scan ref v1 is not a branch')
      expect(bash(checkout, tmp(), { ...env, SHA: 'HEAD;id' }).status).toBe(1)
    }, 30_000)
  })
})

describe('counts.mjs (the commit summary)', () => {
  it('counts red, in-effect, amber, head breaches and read gaps of one subject', () => {
    const d = mkdtempSync(join(tmpdir(), 'oracle-config-counts-'))
    tmps.push(d)
    put(
      d,
      'state/s.json',
      JSON.stringify({
        asOf: { block: 5 },
        counts: { red: 3, pending: 4, proposed: 1, floorBreaches: 0 },
        items: [{ breaches: [{}, { carried: true }] }, { breaches: [{ unconfirmed: true }] }, {}],
        readGaps: ['g1'],
      }),
    )
    put(
      d,
      'changes/s.json',
      JSON.stringify({
        changes: [{ red: true, stillInEffect: true }, { red: true }, { tags: ['read_gap'] }],
      }),
    )
    put(d, 'queues/s.json', JSON.stringify({ changes: [{ tags: ['read_gap', 'x'] }] }))
    expect(subjectCounts(d, 's', { bySubject: { s: { head: 9 } } })).toEqual({
      head: 9,
      red: 3,
      inEffect: 1,
      amber: 4,
      proposed: 1,
      headBreaches: 3,
      headBreachesCarried: 2,
      readGaps: 1,
      readGapRows: 2,
      floorBreaches: 0,
      items: 3,
    })
    expect(subjectCounts(d, 'missing')).toBeNull()
    rmSync(d, { recursive: true, force: true })
  })

  it('the head is the highest among the collected subjects; the others are FAILED', () => {
    const c = (head: number, red: number) => ({
      head,
      red,
      inEffect: 0,
      amber: 0,
      headBreaches: 0,
      readGaps: 0,
      readGapRows: 0,
    })
    const before = { a: c(10, 1), b: c(10, 1), n: null }
    const after = { a: c(30, 2), b: c(40, 1), n: c(20, 0) }
    const { head, text } = summarize(before, after, ['a', 'n'])
    expect(head).toBe(30)
    expect(text.split('\n')).toEqual([
      'a: red 1 -> 2, in-effect 0 -> 0, amber 0 -> 0, head-breach 0 -> 0, read-gap 0 -> 0, read-gap rows 0 -> 0 (head 10 -> 30)',
      'b: FAILED (committed files kept)',
      'n: red - -> 0, in-effect - -> 0, amber - -> 0, head-breach - -> 0, read-gap - -> 0, read-gap rows - -> 0 (head - -> 20)',
    ])
    expect(summarize(before, after, []).head).toBeNull()
  })

  it('stalestFirst: oldest runAt first, never collected (or unreadable) before all, ties stable', () => {
    const cursors = {
      bySubject: {
        a: { runAt: '2026-10-10T04:08:29.964Z' },
        b: { runAt: '2026-10-10T00:39:29.340Z' },
        c: { runAt: '2026-10-10T00:39:29.340Z' },
        d: { runAt: 'not a date' },
      },
    }
    expect(stalestFirst(cursors, ['a', 'b', 'n', 'c', 'd'])).toEqual(['n', 'd', 'b', 'c', 'a'])
    expect(stalestFirst({}, ['x', 'y'])).toEqual(['x', 'y'])
    expect(stalestFirst(undefined, ['x'])).toEqual(['x'])
    // the later of the last success and the last attempt counts
    const attempts = {
      b: Date.parse('2026-10-10T05:00:00Z'),
      n: Date.parse('2026-10-10T01:00:00Z'),
      a: Date.parse('2026-10-10T00:00:00Z'),
    }
    expect(stalestFirst(cursors, ['a', 'b', 'n', 'c', 'd'], attempts)).toEqual([
      'd',
      'c',
      'n',
      'a',
      'b',
    ])
  })

  it('parseAttempts: the latest start per subject, malformed lines ignored', () => {
    expect(parseAttempts('a 100\nb 50\na 300\na 200\n\nbad\nc x\nd 7 8\nE 9\n')).toEqual({
      a: 300_000,
      b: 50_000,
    })
    expect(parseAttempts('')).toEqual({})
  })
})

describe('counts.mjs: which collector wrote the files (collectorOf / collectorNote)', () => {
  const repo = () => {
    const d = mkdtempSync(join(tmpdir(), 'oracle-config-prov-'))
    tmps.push(d)
    put(d, 'data/oracle-registry/config/state/s.json', '{"asOf":{"block":1}}')
    put(d, 'scripts/oracle-registry/config/collect-config.mjs', '// v1\n')
    git(d, 'init', '-q')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'v1 + data')
    return d
  }
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const file = (d: string) => join(d, 'data/oracle-registry/config/state/s.json')

  it('a committed file: its last commit and the collector code there; the same code reads as the same', () => {
    const d = repo()
    const v1 = git(d, 'rev-parse', 'HEAD')
    const b = collectorOf(d, file(d))
    expect(b.sha).toBe(v1)
    // scripts/oracle-registry is a tree there; the other collector paths do not exist
    expect(b.code).toMatch(/^[0-9a-f]{40},-,-,-$/)
    // written again by the same code (uncommitted): no note
    put(d, 'data/oracle-registry/config/state/s.json', '{"asOf":{"block":2}}')
    const a = collectorOf(d, file(d))
    expect(a).toEqual({ sha: null, code: b.code })
    expect(collectorNote({ collector: b }, { collector: a })).toBe('')
  })

  it('a newer collector (committed, or local changes) is named against the older one', () => {
    const d = repo()
    const v1 = git(d, 'rev-parse', 'HEAD')
    const b = collectorOf(d, file(d))
    put(d, 'scripts/oracle-registry/config/collect-config.mjs', '// v2\n')
    const dirty = collectorOf(d, file(d))
    expect(dirty).toEqual(b) // the file itself is still v1's
    put(d, 'data/oracle-registry/config/state/s.json', '{"asOf":{"block":2}}')
    const a = collectorOf(d, file(d))
    expect(a.code).toBe(`${b.code}+dirty`)
    expect(collectorNote({ collector: b }, { collector: a })).toBe(
      `; before = older collector ${v1.slice(0, 8)}`,
    )
    git(d, 'commit', '-q', '-am', 'v2')
    const committed = collectorOf(d, file(d))
    expect(committed.code).not.toBe(b.code)
    expect(collectorNote({ collector: b }, { collector: committed })).toBe(
      `; before = older collector ${v1.slice(0, 8)}`,
    )
    // snapshot records it per subject, only with a repo
    const dir = join(d, 'data/oracle-registry/config')
    expect(snapshot(dir, ['s']).s).not.toHaveProperty('collector')
    expect(snapshot(dir, ['s'], { repo: d }).s?.collector).toEqual(committed)
  })

  it('a shallow clone: the edge commit is no proof of the writer — "collector unknown", never "the same"', () => {
    const d = repo()
    put(d, 'README', 'x\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'docs')
    const c = mkdtempSync(join(tmpdir(), 'oracle-config-shallow-'))
    tmps.push(c)
    git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${d}`, c)
    const b = collectorOf(c, file(c))
    expect(b.code).toBeNull()
    const a = { sha: null, code: 'x' }
    expect(collectorNote({ collector: b }, { collector: a })).toMatch(
      /^; before = collector unknown \(last written in [0-9a-f]{8}\)$/,
    )
  })

  it('not recorded on either side (no --repo, a first collection): no note', () => {
    expect(collectorNote(null, { collector: { sha: null, code: 'x' } })).toBe('')
    expect(collectorNote({ red: 1 }, { red: 2 })).toBe('')
  })
})
