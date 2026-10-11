import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { readEnv } from '../../scripts/lib/venue-reads.mjs'

// .github/workflows/oracle-config-collect.yml runs the collector with no .env.local: the
// RECORDER_RPC_URL secret arrives as an environment variable and is never written to disk.
// readEnv() reads the environment ONLY on a GitHub Actions runner (GITHUB_ACTIONS=true) and ONLY
// when nothing at all is at the path; locally nothing changes.
const RUNNER = { GITHUB_ACTIONS: 'true' }

const dirs: string[] = []
const root = (envLocal?: string) => {
  const d = mkdtempSync(join(tmpdir(), 'read-env-'))
  dirs.push(d)
  if (envLocal !== undefined) writeFileSync(join(d, '.env.local'), envLocal)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('readEnv: .env.local present (local runs, unchanged)', () => {
  it('reads the file, trimmed and unquoted', () => {
    const r = readEnv({
      root: root('A=1\nRECORDER_RPC_URL="https://a.example/k1,https://b.example/k2"\n'),
      env: {},
    })
    expect(r.source).toBe('.env.local')
    expect(r.get('RECORDER_RPC_URL')).toBe('https://a.example/k1,https://b.example/k2')
  })

  it('the file is the only source: the environment never overrides it or fills a gap', () => {
    const env = { RECORDER_RPC_URL: 'https://shell.example/x', OTHER: 'from-shell' }
    const r = readEnv({ root: root('RECORDER_RPC_URL=https://file.example/y\n'), env })
    expect(r.get('RECORDER_RPC_URL')).toBe('https://file.example/y')
    expect(r.get('OTHER')).toBeUndefined()
  })

  it('a .env.local that cannot be read throws, as before (no silent fallback)', () => {
    const d = root()
    mkdirSync(join(d, '.env.local'))
    expect(() =>
      readEnv({ root: d, env: { ...RUNNER, RECORDER_RPC_URL: 'https://x.example/k' } }),
    ).toThrow(/EISDIR|illegal operation/)
  })

  it('off a runner, a missing .env.local throws ENOENT as before: the shell is never read', () => {
    const env = { RECORDER_RPC_URL: 'https://shell.example/x' }
    expect(() => readEnv({ root: root(), env })).toThrow(/ENOENT/)
    expect(() => readEnv({ root: root(), env: { ...env, GITHUB_ACTIONS: '1' } })).toThrow(/ENOENT/)
  })

  it('a dangling .env.local symlink (a worktree whose target is gone) throws, even on a runner', () => {
    const d = root()
    symlinkSync(join(d, 'gone', '.env.local'), join(d, '.env.local'))
    const env = { RECORDER_RPC_URL: 'https://shell.example/x' }
    expect(() => readEnv({ root: d, env })).toThrow(/ENOENT/)
    expect(() => readEnv({ root: d, env: { ...env, ...RUNNER } })).toThrow(/ENOENT/)
  })
})

describe('readEnv: no .env.local on a GitHub Actions runner', () => {
  it('reads the process environment, trimmed and unquoted', () => {
    const r = readEnv({
      root: root(),
      env: { ...RUNNER, RECORDER_RPC_URL: '  "https://a.example/k1,https://b.example/k2"\n' },
    })
    expect(r.source).toBe('environment')
    expect(r.get('RECORDER_RPC_URL')).toBe('https://a.example/k1,https://b.example/k2')
  })

  it('a key the environment lacks is undefined and an empty one is empty, as in the file', () => {
    const fromEnv = readEnv({
      root: root(),
      env: { ...RUNNER, RECORDER_RPC_URL: '   ', DATABASE_URL: 'postgres://db.example/x' },
    })
    const fromFile = readEnv({
      root: root('RECORDER_RPC_URL=\nDATABASE_URL=postgres://db.example/x\n'),
      env: {},
    })
    for (const r of [fromEnv, fromFile]) {
      expect(r.get('RECORDER_RPC_URL')).toBe('')
      expect(r.get('DATABASE_URL_UNPOOLED')).toBeUndefined()
      // the recorders' fallback: get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
      expect(r.get('DATABASE_URL_UNPOOLED') || r.get('DATABASE_URL')).toBe(
        'postgres://db.example/x',
      )
    }
  })

  it('defaults to process.env', () => {
    const key = 'READ_ENV_FALLBACK_TEST_KEY'
    const prev = process.env.GITHUB_ACTIONS
    process.env[key] = 'from-process-env'
    process.env.GITHUB_ACTIONS = 'true'
    try {
      expect(readEnv({ root: root() }).get(key)).toBe('from-process-env')
    } finally {
      delete process.env[key]
      if (prev === undefined) delete process.env.GITHUB_ACTIONS
      else process.env.GITHUB_ACTIONS = prev
    }
  })
})
