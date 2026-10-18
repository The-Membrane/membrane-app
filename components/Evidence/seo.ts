import type { EvidenceDoc } from './types'

/**
 * The SEO description, from the same summary the page renders (docs/SEO_RULESET.md: 140-160
 * characters, server-rendered). The Aave / Morpho split rides with the blended figure, as it
 * does on the page. With no summary (the dataset failed to load) it states the scope and no
 * figure: a stale number is worse than none.
 */
export function evidenceDescription(summary: EvidenceDoc | null): string {
  if (!summary) {
    return 'Every Aave and Morpho liquidation of 10–11 Oct 2025 on four chains, replayed through Membrane’s liquidation engine on each protocol’s own oracle prices.'
  }
  const d = summary.debt
  const sh = (x: number) => `${(x * 100).toFixed(1)}%`
  const g = (x: number) => `${Math.abs(x).toFixed(1)} pp ${x >= 0 ? 'less' : 'more'}`
  return (
    `Aave and Morpho liquidations of ${summary.meta.window.label}, ${summary.meta.positions.toLocaleString('en-US')} compared: the protocols closed ${sh(d.all.realShare)} of the debt, ` +
    `Membrane at its own lines ${sh(d.all.memShare)} (modelled), ${g(d.all.gapPp)} net ` +
    `(Aave ${g(d.byProtocol['aave-v3'].gapPp)}, Morpho ${g(d.byProtocol['morpho-blue'].gapPp)}).`
  )
}
