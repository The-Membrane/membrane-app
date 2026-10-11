import type { CarryForecastRegistry } from './forecastRegistry'
import catalog from '@/tools/carry-news-sources.config.json'

type NewsSource = { id: string; query: string }
type NewsRoute = { routeKey: string; sourceId: string; destinations: string[] }

const sources: NewsSource[] = catalog.sources
const routes: NewsRoute[] = catalog.routes
const sourceById = new Map(sources.map((source) => [source.id, source]))
const routeByKey = new Map(routes.map((route) => [route.routeKey, route]))

/** Exact Carry route and destination identity; a borrow protocol is never a news source. */
export function resolveRouteNewsSource(routeKey: string, destination: string): NewsSource | null {
  const route = routeByKey.get(routeKey)
  if (!route || !route.destinations.includes(destination.toLowerCase())) return null
  return sourceById.get(route.sourceId) ?? null
}

export function routeNewsCoverage(registry: CarryForecastRegistry) {
  const groups = registry.routeGroups.filter((group) =>
    group.contractSubjects.every((subject) =>
      resolveRouteNewsSource(group.routeKey, subject.destinationAddress),
    ),
  )
  const subjects = registry.routeGroups.flatMap((group) =>
    group.contractSubjects.filter((subject) =>
      resolveRouteNewsSource(group.routeKey, subject.destinationAddress),
    ),
  )
  return {
    routeGroups: { enrolled: groups.length, total: registry.routeGroups.length },
    subjects: {
      enrolled: subjects.length,
      total: registry.routeGroups.reduce((sum, group) => sum + group.contractSubjects.length, 0),
    },
  }
}

/** Reject drift or an accidentally broadened catalog before serving route context. */
export function routeNewsCatalogMatchesRegistry(registry: CarryForecastRegistry): boolean {
  if (
    sources.length > 20 ||
    new Set(sources.map((source) => source.id)).size !== sources.length ||
    new Set(sources.map((source) => source.query)).size !== sources.length ||
    new Set(routes.map((route) => route.routeKey)).size !== routes.length ||
    routes.length !== registry.routeGroups.length ||
    sources.some((source) => !source.id || !source.query) ||
    routes.some((route) => !sourceById.has(route.sourceId))
  )
    return false
  return registry.routeGroups.every((group) => {
    const route = routeByKey.get(group.routeKey)
    return (
      route &&
      route.destinations.length === group.contractSubjects.length &&
      new Set(route.destinations).size === route.destinations.length &&
      group.contractSubjects.every((subject) =>
        route.destinations.includes(subject.destinationAddress),
      )
    )
  })
}

export const carryNewsSources = sources
