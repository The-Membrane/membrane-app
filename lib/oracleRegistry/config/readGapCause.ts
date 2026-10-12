// RV11-1 (F4, 2026-10-12; R3, 2026-10-12): a card never renders a read gap it does not count.
// `causeListed`: does a row that rests on a read gap (tagged `read_gap` or `verification_unread`)
// rest on one the card LISTS (`state.readGaps`)? A listed line is its cause when
//   - it quotes the row's title (a carried row: `red history row "<title>" …`), or
//   - the row's notes quote the line (a power over a committee: `<label>: holders not resolved …`), or
//   - it names an address the row names (key, before / after, title), its queued op
//     (`op 0x12345678…`), or starts with the row's label (`<label>: read failed between blocks …`)
//     — at the row's block or the one before (a line with no block is a head read), or
//   - at that block, it names an address only the row's NOTES name (a path controller), or it is
//     a classification that failed there and the row's notes say one did (`1 holder(s) it is
//     ranked against could not be classified`: the row does not name the holder).
// S1 (2026-10-12): moved here from the R3 test helper (tests/unit/oracleRegistryReadGapCause.ts,
// which re-exports it) — the card view (view.ts `untracedRowGaps`) lists the rows of a STORED card
// whose cause the stored read gaps do not name; the R3 every-shape test pins that a card built by
// the current engine has none.

import type { ConfigChange } from './types'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const num = (s: string) => Number(s.replace(/,/g, ''))
const namesIn = (text: string) => {
  const out = new Set([...text.matchAll(/0x[0-9a-f]{40}/gi)].map((m) => short(m[0].toLowerCase())))
  for (const m of text.matchAll(/0x[0-9a-f]{4}…[0-9a-f]{4}/g)) out.add(m[0])
  return out
}

/** The tags that say a row's verdict rests on a read that did not happen. */
export const restsOnAGap = (c: Pick<ConfigChange, 'tags'>) =>
  c.tags.includes('read_gap') || c.tags.includes('verification_unread')

export function causeListed(c: ConfigChange, gaps: readonly string[]): boolean {
  const strong = namesIn(
    [c.key, JSON.stringify(c.before ?? ''), JSON.stringify(c.after ?? ''), c.title].join(' '),
  )
  // the queue's own address is no cause: a head line about another op of that timelock names it
  const op = c.queue?.opId ? `op ${String(c.queue.opId).slice(0, 10)}…` : null
  const weak = namesIn((c.notes ?? []).join(' '))
  const label = c.title.includes(': ') ? c.title.slice(0, c.title.indexOf(': ')) : null
  const near = c.block === undefined ? [] : [c.block, c.block - 1]
  const atBlock = (g: string) => {
    const blocks = (g.match(/\d{1,3}(?:,\d{3})+/g) ?? []).map(num)
    const ranges = [...g.matchAll(/(\d{1,3}(?:,\d{3})+)–(\d{1,3}(?:,\d{3})+)/g)].map(
      (m) => [num(m[1]), num(m[2])] as const,
    )
    if (!blocks.length) return 'head' as const
    return near.some((b) => blocks.includes(b) || ranges.some(([lo, hi]) => b >= lo && b <= hi))
  }
  return gaps.some((g) => {
    if (g.includes(`"${c.title}"`)) return true
    if ((c.notes ?? []).some((n) => n.includes(g))) return true
    const where = atBlock(g)
    if (
      [...strong].some((s) => g.includes(s)) ||
      (op && g.includes(op)) ||
      (label && g.startsWith(`${label}: `))
    )
      return where === 'head' || where
    if (where !== true) return false
    if ([...weak].some((s) => g.includes(s))) return true
    return (
      / could not be classified at block/.test(g) &&
      (c.notes ?? []).some((x) => x.includes('could not be classified'))
    )
  })
}
