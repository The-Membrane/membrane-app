// venueSlug — map any venue display label to its /venue permalink slug (the
// recorder-config `name` in tools/venue-recorder.config.json), or null when the
// venue has no tracked permalink. Carry surfaces mix display labels ('Aave V3')
// with recorder slugs ('aave-v3-usde'); only the four instrumented venues have a
// permalink, so a label with no match must render as plain text, never a link
// into a 404-card. Kept JSX-free so the unit suite can exercise it directly.

const SLUG_BY_LABEL: Record<string, string> = {
  sUSDe: 'sUSDe',
  sUSDS: 'sUSDS',
  scrvUSD: 'scrvUSD',
  'aave-v3-usde': 'aave-v3-usde',
  Aave: 'aave-v3-usde',
  'Aave V3': 'aave-v3-usde',
  'Aave USDe': 'aave-v3-usde',
}

/** The permalink slug for a venue label, or null if it has no tracked permalink. */
export function venueSlug(name: string | undefined | null): string | null {
  if (!name) return null
  if (SLUG_BY_LABEL[name]) return SLUG_BY_LABEL[name]
  const lc = name.toLowerCase()
  for (const [k, v] of Object.entries(SLUG_BY_LABEL)) {
    if (k.toLowerCase() === lc) return v
  }
  return null
}
