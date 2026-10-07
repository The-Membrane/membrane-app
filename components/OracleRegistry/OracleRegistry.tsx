import React, { useEffect, useMemo, useState } from 'react'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'

import { Eyebrow } from '@/components/Carry/atoms'
import { Card } from '@/components/ui/Card'
import { PageTitle } from '@/components/ui/PageTitle'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { AssetViewResponse, OracleIndexResponse } from '@/lib/oracleRegistry/apiTypes'
import type { ConfigCardView, ConfigIndexResponse } from '@/lib/oracleRegistry/config/apiTypes'

import { AssetTabs } from './AssetTabs'
import { ChangesList } from './ChangesList'
import { ConfigCard } from './ConfigCard'
import { type ConfigView, mergeTabs } from './configViewModel'
import { ConsensusHeader } from './ConsensusHeader'
import { OracleCard } from './OracleCard'
import { VIEW_PANEL_ID, ViewSwitch } from './ViewSwitch'
import {
  bandLabel,
  bandsLine,
  basisTallyOf,
  type CardFilter,
  changesForCard,
  colourCountsOf,
  filterCards,
  groupCards,
  honestGapLine,
  voteNote,
} from './viewModel'

// /[chain]/oracles — every catalogued oracle for one asset as a small card, coloured against
// the median of the asset's fresh market feeds: ● within band, ▼ below, ▲ above, ░ stale,
// × unavailable. Basis feeds (exchange rates, CAPO caps, fixed schedules, peg assumptions)
// show their structural gap on a bar instead of being called outliers (the header tallies
// them apart: "basis ▲ above market / ▼ below market"). Data: the collector's
// files in data/oracle-registry via /api/oracles (index) and /api/oracles/[asset].
//
// Each asset with a config card also gets an Oracles | Trust config sub-tab (?view=config,
// deep-linkable as ?asset=rseth&view=config#<changeId>); assets that are only config subjects
// (rsETH) get a config-only tab. Data: /api/oracles?view=config and
// /api/oracles/[asset]?view=config (data/oracle-registry/config).

const PANEL_ID = 'oracle-panel'

// Nothing on this page moves; hover colour fades are the only transitions, and they drop
// out entirely for readers who ask for reduced motion.
const REDUCED_MOTION = {
  '@media (prefers-reduced-motion: reduce)': {
    '& *, & *::before, & *::after': { transition: 'none !important', animation: 'none !important' },
  },
}

/** Unix seconds, refreshed every 30 s after mount (null during SSR so markup matches). */
function useNowSeconds(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000))
    tick()
    const id = setInterval(tick, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json() as Promise<T>
}

export type OracleRegistryProps = {
  initialIndex: OracleIndexResponse | null
  initialAsset: AssetViewResponse | null
  initialSlug: string
  initialConfigIndex?: ConfigIndexResponse | null
  initialConfig?: ConfigCardView | null
  initialView?: ConfigView
}

export const OracleRegistry: React.FC<OracleRegistryProps> = ({
  initialIndex,
  initialAsset,
  initialSlug,
  initialConfigIndex = null,
  initialConfig = null,
  initialView = 'oracles',
}) => {
  const router = useRouter()
  const [slug, setSlug] = useState(initialSlug)
  const [mode, setMode] = useState<ConfigView>(initialView)
  const [historyAll, setHistoryAll] = useState(false)
  const [filter, setFilter] = useState<CardFilter | null>(null)
  const now = useNowSeconds()

  const index = useQuery<OracleIndexResponse>({
    queryKey: ['oracle-registry', 'index'],
    queryFn: () => getJson('/api/oracles'),
    initialData: initialIndex ?? undefined,
    staleTime: 5 * 60_000,
    refetchOnMount: true,
  })

  const configIndex = useQuery<ConfigIndexResponse>({
    queryKey: ['oracle-registry', 'config-index'],
    queryFn: () => getJson('/api/oracles?view=config'),
    initialData: initialConfigIndex ?? undefined,
    staleTime: 5 * 60_000,
    refetchOnMount: true,
  })

  const tabs = useMemo(
    () => mergeTabs(index.data?.assets ?? [], configIndex.data?.subjects ?? []),
    [index.data, configIndex.data],
  )
  const tab = tabs.find((t) => t.slug === slug) ?? null
  // Without a tab entry, assume an oracle asset unless the SSR card says config-only.
  const isOracleAsset = tab
    ? !!tab.oracle
    : !(slug === initialSlug && initialConfig && !initialConfig.oracleSlug)
  const tabConfig = tab?.config ?? null
  const hasConfig = !!tabConfig || (slug === initialSlug && !!initialConfig)
  const effectiveMode: ConfigView = !isOracleAsset
    ? 'config'
    : mode === 'config' && hasConfig
      ? 'config'
      : 'oracles'

  const asset = useQuery<AssetViewResponse>({
    queryKey: ['oracle-registry', 'asset', slug],
    queryFn: () => getJson(`/api/oracles/${encodeURIComponent(slug)}`),
    initialData: slug === initialSlug && initialAsset ? initialAsset : undefined,
    staleTime: 5 * 60_000,
    refetchOnMount: true,
    enabled: isOracleAsset && effectiveMode === 'oracles',
  })

  const config = useQuery<ConfigCardView>({
    queryKey: ['oracle-registry', 'config', slug, historyAll ? 'all' : 'recent'],
    queryFn: () =>
      getJson(
        `/api/oracles/${encodeURIComponent(slug)}?view=config${historyAll ? '&history=all' : ''}`,
      ),
    initialData: slug === initialSlug && !historyAll && initialConfig ? initialConfig : undefined,
    // While the full history loads, keep showing the same asset's trimmed timeline.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === slug ? prev : undefined),
    staleTime: 5 * 60_000,
    refetchOnMount: true,
    enabled: hasConfig && effectiveMode === 'config',
  })

  const replaceQuery = (q: Record<string, string | undefined>) => {
    const query: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries({ ...router.query, ...q }))
      if (v !== undefined) query[k] = v as string | string[]
    void router.replace({ pathname: router.pathname, query }, undefined, {
      shallow: true,
      scroll: false,
    })
  }

  const select = (next: string) => {
    if (next === slug) return
    const nextTab = tabs.find((t) => t.slug === next)
    const nextMode: ConfigView =
      nextTab && !nextTab.oracle
        ? 'config'
        : effectiveMode === 'config' && nextTab?.config
          ? 'config'
          : 'oracles'
    setSlug(next)
    setMode(nextMode)
    setHistoryAll(false)
    setFilter(null)
    replaceQuery({ asset: next, view: nextMode === 'config' ? 'config' : undefined })
  }

  const selectMode = (next: ConfigView) => {
    if (next === effectiveMode) return
    setMode(next)
    replaceQuery({ view: next === 'config' ? 'config' : undefined })
  }

  const view = effectiveMode === 'oracles' ? asset.data : undefined
  const counts = useMemo(() => colourCountsOf(view?.cards ?? []), [view])
  const basis = useMemo(() => basisTallyOf(view?.cards ?? []), [view])
  const groups = useMemo(() => groupCards(filterCards(view?.cards ?? [], filter)), [view, filter])

  return (
    <Box
      maxW="1140px"
      mx="auto"
      px={SPACING.base}
      py={SPACING.lg}
      color={SEMANTIC_COLORS.textPrimary}
      sx={REDUCED_MOTION}
    >
      <Eyebrow>Oracle registry · Ethereum mainnet</Eyebrow>
      <PageTitle
        title="Oracle registry"
        subtitle="The oracles that price an asset in the main Ethereum lending markets, read at one block and compared with the median of its market feeds."
        mt={SPACING.xs}
      />

      {tabs.length > 0 && (
        <AssetTabs assets={tabs} selected={slug} onSelect={select} panelId={PANEL_ID} now={now} />
      )}

      <Box
        id={PANEL_ID}
        role="tabpanel"
        aria-labelledby={`oracle-tab-${slug}`}
        aria-busy={
          effectiveMode === 'oracles'
            ? asset.isFetching && !view
            : config.isFetching && !config.data
        }
      >
        {(hasConfig || !isOracleAsset) && (
          <ViewSwitch
            view={effectiveMode}
            onSelect={selectMode}
            oraclesAvailable={isOracleAsset}
            config={tabConfig}
            now={now}
          />
        )}
        <Box id={VIEW_PANEL_ID} role="tabpanel" aria-labelledby={`oracle-view-${effectiveMode}`}>
          {effectiveMode === 'config' ? (
            config.data ? (
              <ConfigCard
                key={config.data.subject}
                view={config.data}
                now={now}
                onShowOracles={isOracleAsset ? () => selectMode('oracles') : null}
                onLoadAll={() => setHistoryAll(true)}
                loadingAll={historyAll && config.isFetching}
              />
            ) : config.isError ? (
              <Card mt={SPACING.lg} p={SPACING.base}>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Could not load the config card for {slug}.{' '}
                  <Box
                    as="button"
                    type="button"
                    onClick={() => void config.refetch()}
                    textDecoration="underline"
                    color={SEMANTIC_COLORS.textPrimary}
                    _focusVisible={FOCUS_STYLES.ring}
                  >
                    Retry
                  </Box>
                </Text>
              </Card>
            ) : (
              <Card mt={SPACING.lg} p={SPACING.md} h="320px" variant="subtle" aria-hidden="true" />
            )
          ) : view ? (
            <>
              {!view.available && (
                <Text
                  mt={SPACING.base}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.warning}
                >
                  No snapshot collected yet — mechanisms only.
                </Text>
              )}
              <ConsensusHeader
                view={view}
                counts={counts}
                basis={basis}
                now={now}
                filter={filter}
                onFilter={setFilter}
              />

              {groups.map((g) => (
                <Box
                  as="section"
                  key={g.key}
                  mt={SPACING.lg}
                  aria-labelledby={`oracle-group-${g.key}`}
                >
                  <HStack spacing={SPACING.sm} align="baseline" mb={SPACING.sm}>
                    <Text
                      id={`oracle-group-${g.key}`}
                      as="h2"
                      fontFamily={TYPOGRAPHY.fontDisplay}
                      fontSize={TYPOGRAPHY.h3}
                      color={SEMANTIC_COLORS.textPrimary}
                    >
                      {g.title}
                    </Text>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize="11px"
                      color={SEMANTIC_COLORS.textTertiary}
                    >
                      {g.cards.length} · {g.note}
                    </Text>
                  </HStack>
                  <Grid
                    templateColumns="repeat(auto-fill, minmax(250px, 1fr))"
                    gap={SPACING.md}
                    alignItems="start"
                  >
                    {g.cards.map((c) => (
                      <OracleCard
                        key={c.id}
                        card={c}
                        historyTs={view.history.ts}
                        consensusSeries={view.history.consensus}
                        changes={changesForCard(view.changes, c)}
                        voteNote={voteNote(c, view.consensus)}
                      />
                    ))}
                  </Grid>
                </Box>
              ))}
              {filter && groups.length === 0 && (
                <Text
                  mt={SPACING.lg}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  no cards in this state
                </Text>
              )}

              <ChangesList
                changes={view.changes}
                cards={view.cards}
                days={view.changesWindow.days}
              />

              <Box
                as="details"
                mt={SPACING.xl}
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                pt={SPACING.md}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.textSecondary}
              >
                <Box
                  as="summary"
                  cursor="pointer"
                  letterSpacing="0.2em"
                  textTransform="uppercase"
                  fontSize="10px"
                  _focusVisible={FOCUS_STYLES.ring}
                >
                  Method
                </Box>
                <Box as="ul" pl={SPACING.base} mt={SPACING.sm} lineHeight={1.6}>
                  <li>Consensus: {view.policies.consensus}</li>
                  <li>Staleness: {view.policies.staleness}</li>
                  <li>
                    {bandsLine(view.policies.bands)} This asset: {bandLabel(view.band)}. Exactly on
                    the band counts as within. History: {view.history.days ?? 30} days replayed
                    hourly with the same rules.
                  </li>
                  <li>{honestGapLine(view.policies.bands)}</li>
                  {view.excluded.map((x) => (
                    <li key={`${x.provider}-${x.reason}`}>
                      Not listed — {x.provider}: {x.reason}
                    </li>
                  ))}
                </Box>
              </Box>
            </>
          ) : asset.isError ? (
            <Card mt={SPACING.lg} p={SPACING.base}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                Could not load {slug}.{' '}
                <Box
                  as="button"
                  type="button"
                  onClick={() => void asset.refetch()}
                  textDecoration="underline"
                  color={SEMANTIC_COLORS.textPrimary}
                  _focusVisible={FOCUS_STYLES.ring}
                >
                  Retry
                </Box>
              </Text>
            </Card>
          ) : (
            <Grid
              templateColumns="repeat(auto-fill, minmax(250px, 1fr))"
              gap={SPACING.md}
              mt={SPACING.lg}
              aria-hidden="true"
            >
              {Array.from({ length: 6 }, (_, i) => (
                <Card key={i} p={SPACING.md} h="260px" variant="subtle" />
              ))}
            </Grid>
          )}
        </Box>
      </Box>
    </Box>
  )
}

export default OracleRegistry
