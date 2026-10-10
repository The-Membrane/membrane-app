// Fail-closed audit (2026-10-10, MISSED collect.mjs:811 / EV MISSED-2): an EMPTY getLogs answer
// is confirmed on a second, independent endpoint before anyone believes it. The oracle collector's
// governance look-back took one endpoint's empty chunk as "no event" and cached it for the rest of
// the run; the config cards' OR-1 / AD-9 oracle rows (source swaps, CAPO / heartbeat moves) come
// from that file, so a lost chunk dropped them silently. The config collector's own scans use
// `crossCheckedLogs` (scripts/oracle-registry/config/lib/rpc.mjs) for the same reason.
//
//   confirmedLogs(primary, secondary) — `primary` / `secondary` are thunks returning the logs of
//   ONE range on each endpoint:
//     primary non-empty                      → its logs
//     primary empty, secondary non-empty     → the secondary's (a false-empty corrected)
//     both empty                             → [] (confirmed)
//     anything else (a failure, no second endpoint, a non-array answer) → THROWS: the caller
//     treats the range as not read (the oracle collector stops; the cards keep the old file and
//     list its stale window as a read gap).

const asList = (r, who) => {
  if (!Array.isArray(r)) throw new Error(`non-array getLogs answer from the ${who} endpoint`)
  return r
}

export async function confirmedLogs(primary, secondary) {
  const a = asList(await primary(), 'first')
  if (a.length) return a
  if (!secondary) throw new Error('empty getLogs answer not confirmed (no second log endpoint)')
  return asList(await secondary(), 'second')
}

// Fail-closed review (2026-10-10, OC-4 / rules #2): `confirmedLogs` checked only the JOINED answer
// of an adaptive read. The primary was split in halves inside `getLogsAdaptive` when it errored
// (a range or result-size limit), so a false-empty half next to a non-empty half gave a non-empty
// total that was accepted with no second look — the R-5 bug the config collector's
// `crossCheckedLogs` fixed in review round 10, back in the oracle collector (an
// `AggregatorConfirmed` lost next to an `OwnershipTransferred`). And a non-empty second answer was
// taken whole (EV-04): one false-empty piece of it was never re-asked.
//
//   crossCheckedRange(readPrimary, readSecondary, from, to)
//     readPrimary / readSecondary  (from: bigint, to: bigint) → logs of exactly that range; ONE
//                                  request (never split inside), throws on failure
//   Every range answered is checked on its own:
//     primary non-empty                      → its logs (a partial non-empty answer: UQ-28)
//     primary FAILS                          → the range is halved; each half is checked on its own
//     primary empty                          → the secondary is read; a range it FAILS on is halved
//                                              into pieces, each answered on its own. A piece the
//                                              secondary answers empty is confirmed only when the
//                                              primary's empty answer for the whole range holds (no
//                                              piece came back non-empty); otherwise the primary is
//                                              asked for that piece again: [] confirms it, logs are
//                                              taken, a failure THROWS.
//     no second endpoint, or a range that cannot be split further → THROWS (not read).
export const MIN_SPLIT_SPAN = 500n

async function secondaryPieces(read, from, to, depth) {
  try {
    return [{ from, to, logs: asList(await read(from, to), 'second') }]
  } catch (e) {
    if (to - from < MIN_SPLIT_SPAN || depth > 12) throw e
    const mid = from + (to - from) / 2n
    return [
      ...(await secondaryPieces(read, from, mid, depth + 1)),
      ...(await secondaryPieces(read, mid + 1n, to, depth + 1)),
    ]
  }
}

export async function crossCheckedRange(readPrimary, readSecondary, from, to, depth = 0) {
  from = BigInt(from)
  to = BigInt(to)
  let a = null
  let aErr = null
  try {
    a = asList(await readPrimary(from, to), 'first')
  } catch (e) {
    aErr = e
  }
  if (a && a.length) return a
  if (aErr) {
    if (to - from >= MIN_SPLIT_SPAN && depth <= 12) {
      const mid = from + (to - from) / 2n
      const x = await crossCheckedRange(readPrimary, readSecondary, from, mid, depth + 1)
      const y = await crossCheckedRange(readPrimary, readSecondary, mid + 1n, to, depth + 1)
      return [...x, ...y]
    }
  }
  if (!readSecondary)
    throw aErr ?? new Error('empty getLogs answer not confirmed (no second log endpoint)')
  let pieces
  try {
    pieces = await secondaryPieces(readSecondary, from, to, 0)
  } catch (e) {
    throw aErr ?? e
  }
  // the primary's empty answer is evidence for a piece only while it was not shown false
  const primaryEmptyHolds = !aErr && pieces.every((p) => !p.logs.length)
  const out = []
  for (const p of pieces) {
    if (p.logs.length) {
      out.push(...p.logs)
      continue
    }
    if (primaryEmptyHolds) continue // both endpoints answered this range empty
    out.push(...asList(await readPrimary(p.from, p.to), 'first')) // throws when it fails
  }
  return out
}
