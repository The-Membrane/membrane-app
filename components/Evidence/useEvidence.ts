import { useEffect, useMemo, useRef, useState } from 'react'

import { CohortRow, EvidenceDoc, OutcomeFilter, SortKey, sparedUsd } from './types'

const SRC = '/data/oct10-2025/evidence.json'

/**
 * Loads the counterfactual dataset. It is ~870 KB, so it is fetched at runtime
 * rather than bundled into the page.
 *
 * Protocol-scoped data: identical with or without a wallet, so this page is
 * fully populated for a stranger (V20 demo-first rule). There is nothing here to
 * gate and nothing to fake.
 */
export function useEvidence(initial?: EvidenceDoc | null) {
  // `initial` is the summary-only doc the page server-renders (meta/debt/time/byAsset
  // with an empty cohort, ~2KB). It means a crawler and a first paint both see the real
  // numbers instead of a spinner — docs/SEO_RULESET.md R1. The full 2,350-row cohort is
  // still fetched client-side, because inlining ~870KB into the HTML is worse than a
  // second request for a table most visitors never scroll to.
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
    fetch(SRC)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json()
      })
      .then((d: EvidenceDoc) => {
        if (mounted.current) setDoc(d)
      })
      .catch((e: unknown) => {
        if (mounted.current) setError(e instanceof Error ? e.message : 'failed to load')
      })
  }, [])

  return { doc, error, isLoading: !doc && !error }
}

/** Filter + sort the cohort. Pure, so the table stays cheap to re-render. */
export function useCohort(
  rows: CohortRow[] | undefined,
  opts: {
    asset: string
    chain: string
    outcome: OutcomeFilter
    sort: SortKey
    limit: number
  },
) {
  return useMemo(() => {
    if (!rows) return { visible: [], total: 0, matched: 0 }

    const matched = rows.filter((r) => {
      if (opts.asset !== 'all' && r.collSymbol !== opts.asset) return false
      if (opts.chain !== 'all' && r.chain !== opts.chain) return false
      switch (opts.outcome) {
        case 'membraneLess':
          return r.membraneClosedFrac < r.aaveClosedFrac
        case 'membraneMore':
          return r.membraneClosedFrac >= r.aaveClosedFrac
        case 'cured':
          return r.cure?.curedInWindow === true
        case 'notCured':
          return r.cure != null && !r.cure.curedInWindow
        default:
          return true
      }
    })

    const sorted = [...matched].sort((a, b) => {
      switch (opts.sort) {
        case 'spared':
          return sparedUsd(b) - sparedUsd(a)
        case 'events':
          return b.events - a.events
        case 'ltv0':
          return b.ltv0 - a.ltv0
        default:
          return b.debtUsd - a.debtUsd
      }
    })

    return {
      visible: sorted.slice(0, opts.limit),
      total: rows.length,
      matched: matched.length,
    }
  }, [rows, opts.asset, opts.chain, opts.outcome, opts.sort, opts.limit])
}

/** Distinct values for the filter selects, in descending frequency. */
export function useFacets(rows: CohortRow[] | undefined) {
  return useMemo(() => {
    const assets = new Map<string, number>()
    const chains = new Map<string, number>()
    for (const r of rows ?? []) {
      assets.set(r.collSymbol, (assets.get(r.collSymbol) ?? 0) + 1)
      chains.set(r.chain, (chains.get(r.chain) ?? 0) + 1)
    }
    const rank = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    return { assets: rank(assets), chains: rank(chains) }
  }, [rows])
}
