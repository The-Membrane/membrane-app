import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { appSha, type GitRunner } from '@/lib/carryScan/appSha'
import { shortAppSha } from '@/lib/carryScan/format'
import { isCarryScanFile } from '@/lib/carryScan/load'

const SHA = 'e503d0e7' + '0'.repeat(32)

// A fake git: `rev-parse HEAD` answers SHA, `status` answers `porcelain` (or throws).
const fakeGit =
  (porcelain: string | Error, head: string | Error = `${SHA}\n`): GitRunner =>
  (args) => {
    const out = args[0] === 'rev-parse' ? head : porcelain
    if (out instanceof Error) throw out
    return out
  }

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// 2026-10-11: a dry run on uncommitted code stamped e503d0e7 (plain `git rev-parse HEAD`)
// on a schema-2 file that commit could not have produced.
describe('appSha: the commit the scan ran from', () => {
  it('a clean work tree stamps HEAD', () => {
    expect(appSha(fakeGit(''))).toBe(SHA)
  })

  it('tracked changes stamp HEAD-dirty; untracked files alone do not', () => {
    expect(appSha(fakeGit(' M lib/carryScan/scan.ts\n'))).toBe(`${SHA}-dirty`)
    const seen: string[][] = []
    appSha((args) => {
      seen.push(args)
      return args[0] === 'rev-parse' ? SHA : ''
    })
    expect(seen).toContainEqual(['status', '--porcelain', '--untracked-files=no'])
  })

  it('an unreadable status never claims a clean tree; no HEAD stamps null', () => {
    expect(appSha(fakeGit(new Error('git status failed')))).toBe(`${SHA}-dirty`)
    expect(appSha(fakeGit('', new Error('not a git repository')))).toBeNull()
    expect(appSha(fakeGit('', ''))).toBeNull()
  })

  it('the loader accepts a -dirty stamp and the page prints it with its suffix', () => {
    const file = { schemaVersion: 2, week: '2026-W41', asOf: 1, rows: [], appSha: `${SHA}-dirty` }
    expect(isCarryScanFile(file)).toBe(true)
    expect(shortAppSha(`${SHA}-dirty`)).toBe('e503d0e7-dirty')
    expect(shortAppSha(SHA)).toBe('e503d0e7')
    expect(shortAppSha(null)).toBeNull()
  })

  it('against real git: clean, untracked-only, then a tracked edit', () => {
    const d = mkdtempSync(join(tmpdir(), 'carry-scan-appsha-'))
    dirs.push(d)
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', d, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    git('init', '-q')
    writeFileSync(join(d, 'a.txt'), 'one\n')
    git('add', 'a.txt')
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'init',
    )
    const head = git('rev-parse', 'HEAD').trim()
    const run: GitRunner = (args) => git(...args)
    expect(appSha(run)).toBe(head)
    writeFileSync(join(d, 'untracked.json'), '{}')
    expect(appSha(run)).toBe(head)
    writeFileSync(join(d, 'a.txt'), 'two\n')
    expect(appSha(run)).toBe(`${head}-dirty`)
  })
})
