import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { CITES, OBJECTIONS, SOLIDITY_PIN } from '@/lib/landing/objections'
import { CARRY_CITES, CARRY_OBJECTIONS } from '@/lib/landing/carry'

// Every contract line the landing's objection cards cite must still contain its
// identifier at the pinned membrane-solidity commit (Q41 refuting review D6). Reads the
// sibling checkout read-only with `git show <pin>:<path>`. Set MEMBRANE_SOLIDITY_DIR to
// point elsewhere; the suite skips (and says so) when no checkout is reachable.
const DIR = process.env.MEMBRANE_SOLIDITY_DIR ?? path.resolve(__dirname, '../../../../membrane-solidity')
const hasRepo = fs.existsSync(path.join(DIR, '.git'))

function lineAt(file: string, n: number): string {
  const src = execFileSync('git', ['-C', DIR, 'show', `${SOLIDITY_PIN}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return src.split('\n')[n - 1] ?? ''
}

describe.skipIf(!hasRepo)(`landing citations at membrane-solidity ${SOLIDITY_PIN}`, () => {
  for (const [name, c] of Object.entries({ ...CITES, ...CARRY_CITES })) {
    it(`${name}: ${c.path}:${c.from} contains "${c.expect}"`, () => {
      expect(lineAt(c.path, c.from)).toContain(c.expect)
      expect(c.to).toBeGreaterThanOrEqual(c.from)
    })
  }
  it('every card citation is a pinned CITES entry', () => {
    const pinned = new Set<unknown>([...Object.values(CITES), ...Object.values(CARRY_CITES)])
    for (const o of [...OBJECTIONS, ...CARRY_OBJECTIONS]) for (const f of o.facts) for (const c of f.cites ?? []) expect(pinned.has(c)).toBe(true)
  })
})
