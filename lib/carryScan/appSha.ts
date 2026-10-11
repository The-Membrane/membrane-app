/**
 * The commit stamped into each weekly file as `appSha` (scripts/carry-scan/run.ts).
 * Server/CLI only: it runs git.
 *
 * A work tree with TRACKED changes did not run that commit, so the stamp is `<sha>-dirty`
 * (2026-10-11: a dry run on uncommitted code stamped plain e503d0e7 on a schema-2 file that
 * commit could not produce). Untracked files do not count (`--untracked-files=no`): an output
 * directory or a scratch file is not the scan's code. A status that cannot be read also
 * stamps `-dirty`: the stamp never claims a clean tree it did not check. No HEAD → null.
 * The loader does not validate the field; the page prints `shortAppSha` (./format.ts).
 */

import { execFileSync } from 'child_process'

import { DIRTY_SUFFIX } from './format'

/** Runs `git <args>` and returns stdout; throws when git fails. */
export type GitRunner = (args: string[]) => string

const execGit: GitRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

export function appSha(git: GitRunner = execGit): string | null {
  let head: string
  try {
    head = git(['rev-parse', 'HEAD']).trim()
  } catch {
    return null
  }
  if (!head) return null
  let dirty: boolean
  try {
    dirty = git(['status', '--porcelain', '--untracked-files=no']).trim() !== ''
  } catch {
    dirty = true
  }
  return dirty ? `${head}${DIRTY_SUFFIX}` : head
}
