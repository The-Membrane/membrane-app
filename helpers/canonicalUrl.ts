/**
 * A statically optimized page server-renders with asPath set to its route pattern
 * ("/[chain]/simulator"), so [chain] is resolved here. Any other unresolved segment
 * omits the tag rather than emitting a pattern URL.
 */
export const canonicalUrl = (siteUrl: string, rawPath: string, chain: string): string | undefined => {
  const routePath = rawPath.split(/[?#]/)[0].replace('[chain]', chain)
  if (!siteUrl || routePath.includes('[')) return undefined
  return `${siteUrl}${routePath === '/' ? '' : routePath}`
}
