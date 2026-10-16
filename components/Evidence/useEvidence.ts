import { useEffect, useMemo, useRef, useState } from 'react'

import {
  CohortRow,
  EvidenceDoc,
  EvidenceFile,
  OutcomeFilter,
  ProtocolFilter,
  SortKey,
  compareRow,
  decodeEvidence,
  sparedUsd,
} from './types'

export const EVIDENCE_SRC = '/data/oct10-2025/evidence-census.json'

/**
 * Loads the full on-chain census of 10-11 Oct 2025 (scripts/build-evidence-census.ts). It is
 * about 1 MB (about 270 KB gzipped), so it is fetched at runtime rather than bundled.
 *
 * Protocol-scoped data: identical with or without a wallet, so this page is fully populated
 * for a stranger (V20 demo-first rule). There is nothing here to gate and nothing to fake.
 */
export function useEvidence(initial?: EvidenceDoc | null) {
  // `initial` is the summary-only doc the page server-renders (everything but the cohort).
  // A crawler and a first paint both see the real numbers instead of a spinner —
  // docs/SEO_RULESET.md R1. The 3,197-row cohort is still fetched client-side, because
  // inlining it into the HTML is worse than a second request for a table most visitors
  // never scroll to.
  const [doc, setDoc] = useState<EvidenceDoc | null>(initial ?? null)
  const [error, setError] = useState<string | null>(null)

  // Shared ref, not a per-closure flag. React 18 StrictMode mounts twice in dev:
  // a captured `let live` is set false by the first cleanup and then throws away
  // the resolved fetch, leaving the page stuck on "Loading" forever. A ref is
  // re-set to true by the second mount before the fetch lands. Same guard shape
  // as components/Borrow/hooks/useLiveMarketData.ts.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    fetch(EVIDENCE_SRC)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json()
      })
      .then((d: EvidenceFile) => {
        if (mounted.current) setDoc(decodeEvidence(d))
      })
      .catch((e: unknown) => {
        if (mounted.current) setError(e instanceof Error ? e.message : 'failed to load')
      })
  }, [])

  return { doc, error, isLoading: !doc && !error }
}

/** Does a row pass the outcome filter? Exported so the test can count without the hook. */
export function matchesOutcome(r: CohortRow, outcome: OutcomeFilter): boolean {
  switch (outcome) {
    case 'membraneLess':
      return compareRow(r) === 'less'
    case 'membraneMore':
      return compareRow(r) === 'more'
    case 'equal':
      return compareRow(r) === 'equal'
    case 'cured':
      return r.cure?.curedInWindow === true
    case 'notCured':
      return r.cure != null && !r.cure.noWindow && !r.cure.curedInWindow
    case 'gridEnd':
      return r.gridEndUsd != null
    default:
      return true
  }
}

/** Filter + sort the cohort. Pure, so the table stays cheap to re-render. */
export function useCohort(
  rows: CohortRow[] | undefined,
  opts: {
    asset: string
    chain: string
    protocol?: ProtocolFilter
    outcome: OutcomeFilter
    sort: SortKey
    limit: number
  },
) {
  const protocol = opts.protocol ?? 'all'
  return useMemo(() => {
    if (!rows) return { visible: [], total: 0, matched: 0 }

    const matched = rows.filter((r) => {
      if (opts.asset !== 'all' && r.primary !== opts.asset) return false
      if (opts.chain !== 'all' && r.chain !== opts.chain) return false
      if (protocol !== 'all' && r.protocol !== protocol) return false
      return matchesOutcome(r, opts.outcome)
    })

    // Unpriced positions have no dollar figure; they sort last on every dollar key.
    const dollars = (v: number | null) => (v == null ? -Infinity : v)
    const sorted = [...matched].sort((a, b) => {
      switch (opts.sort) {
        case 'spared':
          return dollars(sparedUsd(b)) - dollars(sparedUsd(a))
        case 'events':
          return b.events - a.events
        case 'ltv0':
          return b.ltv0 - a.ltv0
        default:
          return dollars(b.debtUsd) - dollars(a.debtUsd)
      }
    })

    return {
      visible: sorted.slice(0, opts.limit),
      total: rows.length,
      matched: matched.length,
    }
  }, [rows, opts.asset, opts.chain, protocol, opts.outcome, opts.sort, opts.limit])
}

/** Distinct values for the filter selects, in descending frequency. */
export function useFacets(rows: CohortRow[] | undefined) {
  return useMemo(() => {
    const assets = new Map<string, number>()
    const chains = new Map<string, number>()
    for (const r of rows ?? []) {
      assets.set(r.primary, (assets.get(r.primary) ?? 0) + 1)
      chains.set(r.chain, (chains.get(r.chain) ?? 0) + 1)
    }
    const rank = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k)
    return { assets: rank(assets), chains: rank(chains) }
  }, [rows])
}
