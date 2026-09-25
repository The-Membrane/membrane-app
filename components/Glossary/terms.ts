// Glossary terms — pure data, JSX-free so tests/unit/glossary.test.ts reads it
// directly. Every definition is measured from code; the source is recorded per
// term in `source` (repo path) so a reviewer can re-check the number.
//
// Owner ruling 2026-09-25 ("align shared words"): exit LEGS (Radar/Strats stress
// model) and size TIERS (Carry capacity fill order) are two different concepts.
// Both use "cooldown"; neither uses "cooling" in user-facing text.

export type GlossaryGroupId = 'legs' | 'verdicts' | 'tiers' | 'depth' | 'alarms'

export type GlossaryTerm = {
  /** Anchor id — /ethereum/glossary#<id> is the citable URL. Unique. */
  id: string
  term: string
  group: GlossaryGroupId
  definition: string
  /** Repo path the definition is measured from. */
  source: string
  /** For alarm rules: the rule kind as the alarm system names it. */
  alarmKind?: string
}

export const GLOSSARY_GROUPS: { id: GlossaryGroupId; title: string }[] = [
  { id: 'legs', title: 'Exit legs' },
  { id: 'verdicts', title: 'Verdicts' },
  { id: 'tiers', title: 'Size tiers' },
  { id: 'depth', title: 'Depth' },
  { id: 'alarms', title: 'Venue alarms' },
]

const RADAR = 'components/Radar/radarLogic.ts'
const TIERS = 'components/Carry/utils.ts'
const ALARMS = 'scripts/lib/alarmRules.mjs'

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  // ── Exit legs (Radar/Strats stress model) ────────────────────────────────
  {
    id: 'instant-leg',
    term: 'Instant leg',
    group: 'legs',
    definition:
      "Instant withdrawable liquidity divided by your position size. Scored only where instant liquidity is a real read; cooldown vaults have no instant leg.",
    source: RADAR,
  },
  {
    id: 'cooldown-leg',
    term: 'Cooldown leg',
    group: 'legs',
    definition:
      'The recorded cooldown gate on an ERC-4626 cooldown vault. It delays 100% of an exit regardless of size: up to 1 day is caution, longer than 1 day is exposed.',
    source: RADAR,
  },
  {
    id: 'flow-leg',
    term: 'Flow leg',
    group: 'legs',
    definition:
      "The venue's worst recorded single-day outflow divided by your position size. A large past outflow proves the venue can push size out.",
    source: RADAR,
  },

  // ── Verdicts ─────────────────────────────────────────────────────────────
  {
    id: 'clear',
    term: 'Clear',
    group: 'verdicts',
    definition:
      "A leg covers your size 10x or more. A venue is clear only when every leg that applies is clear; the venue verdict is its weakest leg, never an average.",
    source: RADAR,
  },
  {
    id: 'caution',
    term: 'Caution',
    group: 'verdicts',
    definition:
      'A leg covers your size at least 1x but under 10x, or a cooldown gate is 1 day or shorter. A venue with no recorded capacity or flow is also caution.',
    source: RADAR,
  },
  {
    id: 'exposed',
    term: 'Exposed',
    group: 'verdicts',
    definition: 'A leg covers under 1x your size, or a cooldown gate is longer than 1 day.',
    source: RADAR,
  },

  // ── Size tiers (Carry capacity fill order) ───────────────────────────────
  {
    id: 'instant-tier',
    term: 'Instant tier',
    group: 'tiers',
    definition:
      "The first slice of an exit, up to the venue's instant depth, priced at the instant exit cost. Size fills tiers in order: instant, then cooldown, then stranded.",
    source: TIERS,
  },
  {
    id: 'cooldown-tier',
    term: 'Cooldown tier',
    group: 'tiers',
    definition:
      'The next slice of an exit after instant depth is used up, up to the cooldown depth, priced at the cooldown exit cost.',
    source: TIERS,
  },
  {
    id: 'stranded',
    term: 'Stranded',
    group: 'tiers',
    definition:
      'Exit size beyond instant plus cooldown depth, priced at the stranded exit cost. Blended exit cost is the size-weighted mix of all three tiers.',
    source: TIERS,
  },

  // ── Depth ────────────────────────────────────────────────────────────────
  {
    id: 'instant-swap-out-depth',
    term: 'Instant swap-out depth',
    group: 'depth',
    definition:
      "The sum, across a venue's enabled secondary-market pools, of the reserve you can swap into when exiting the venue token, at $1 per stable. The venue-token side is not counted.",
    source: 'components/Carry/venueLogLogic.ts · scripts/lib/venue-reads.mjs',
  },

  // ── Venue alarms ─────────────────────────────────────────────────────────
  {
    id: 'gate-change',
    term: 'Gate change',
    group: 'alarms',
    alarmKind: 'gate_change',
    definition:
      'Alarm. A cooldown-duration change, an instant-liquidity shift, or a redemption-terms page edit recorded in the last 24 hours.',
    source: ALARMS,
  },
  {
    id: 'drawdown-fast',
    term: 'Fast drawdown',
    group: 'alarms',
    alarmKind: 'drawdown_fast',
    definition:
      "Alarm. The venue's capacity (instant liquidity where read, else total assets) is more than 20% below its 7-day peak.",
    source: ALARMS,
  },
  {
    id: 'net-outflow-streak',
    term: 'Net outflow streak',
    group: 'alarms',
    alarmKind: 'net_outflow_streak',
    definition:
      'Consecutive days of net outflow whose total exceeds 10% of TVL. Watch at 10 days, alarm at 20; a day with no outflow breaks the streak.',
    source: ALARMS,
  },
  {
    id: 'headroom-thin',
    term: 'Thin headroom',
    group: 'alarms',
    alarmKind: 'headroom_thin',
    definition:
      "Instant exit liquidity divided by the venue's worst recorded single-day outflow. Watch under 3x, alarm under 1.5x.",
    source: ALARMS,
  },
  {
    id: 'utilization',
    term: 'Utilization',
    group: 'alarms',
    alarmKind: 'utilization',
    definition:
      'Debt divided by debt plus available liquidity on a lending reserve. Watch above 90%, alarm above 95%.',
    source: ALARMS,
  },
  {
    id: 'depth-skew',
    term: 'Depth skew',
    group: 'alarms',
    alarmKind: 'depth_skew',
    definition:
      "The larger side of a venue's exit pool as a share of the pool. Watch above 80%, alarm above 90%.",
    source: ALARMS,
  },
  {
    id: 'depth-collapse',
    term: 'Depth collapse',
    group: 'alarms',
    alarmKind: 'depth_collapse',
    definition:
      'Instant swap-out depth below its 7-day peak. Watch at a fall above 35%, alarm above 50%.',
    source: ALARMS,
  },
  {
    id: 'blind-spot',
    term: 'Blind spot',
    group: 'alarms',
    definition:
      'A signal the alarm cannot evaluate at a venue: yield flatness everywhere; depth-vs-book without a verified depth market; terms changes without a watched terms page; instant-exit headroom without an instant-liquidity read.',
    source: ALARMS,
  },
]

/** The citable URL of one term. */
export const termUrl = (siteUrl: string, chain: string, id: string): string =>
  `${siteUrl}/${chain}/glossary#${id}`

/** schema.org DefinedTermSet for the page's JSON-LD block. */
export const buildDefinedTermSet = (siteUrl: string, chain: string) => ({
  '@context': 'https://schema.org',
  '@type': 'DefinedTermSet',
  '@id': `${siteUrl}/${chain}/glossary`,
  name: 'Membrane glossary',
  url: `${siteUrl}/${chain}/glossary`,
  publisher: { '@type': 'Organization', name: 'Membrane', url: siteUrl },
  hasDefinedTerm: GLOSSARY_TERMS.map((t) => ({
    '@type': 'DefinedTerm',
    '@id': termUrl(siteUrl, chain, t.id),
    name: t.term,
    description: t.definition,
    url: termUrl(siteUrl, chain, t.id),
    inDefinedTermSet: `${siteUrl}/${chain}/glossary`,
  })),
})
