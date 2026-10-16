import { Box, Grid, HStack, Select, Text, VStack } from '@chakra-ui/react'
import React, { useState } from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, InfoTip } from './atoms'
import {
  CHAIN_NAME,
  CURE_LEGEND,
  GRID_END_MARK,
  PROTOCOL_NAME,
  minuteClock,
  pct,
  usd,
} from './format'
import { useCohort, useFacets } from './useEvidence'
import { CohortRow, OutcomeFilter, ProtocolFilter, SortKey, sparedUsd } from './types'

const COLS = '1.3fr 0.8fr 0.8fr 0.7fr 0.8fr 0.9fr 0.6fr'
const PAGE = 100

const selectProps = {
  size: 'sm' as const,
  bg: SEMANTIC_COLORS.bgTertiary,
  color: SEMANTIC_COLORS.textPrimary,
  borderRadius: 0,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderMedium,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.xs,
  transition: TRANSITIONS.colors,
  _focus: FOCUS_STYLES.ring,
}

const legs = (xs: [string, number | null][]) =>
  xs.map(([sym, v]) => (v == null ? sym : `${usd(v)} ${sym}`)).join(' + ')

/** The cure column's state, one place. */
const cureState = (r: CohortRow): { text: string; color: string } => {
  if (!r.cure || r.cure.noWindow) return { text: '—', color: SEMANTIC_COLORS.textTertiary }
  if (r.cure.healthyAt8h && r.cure.curedInWindow)
    return { text: 'yes', color: SEMANTIC_COLORS.success }
  if (r.cure.curedInWindow) return { text: '8h', color: SEMANTIC_COLORS.warning }
  return { text: 'no', color: SEMANTIC_COLORS.danger }
}

/** Expanded detail for one position. Opens in place under its row. */
const Detail: React.FC<{ r: CohortRow }> = ({ r }) => {
  const venue =
    r.protocol === 'aave'
      ? `${PROTOCOL_NAME.aave} ${r.market === 'core' ? 'Core' : r.market}`
      : PROTOCOL_NAME.morpho
  const times = r.events === 1 ? 'once' : `${r.events} separate times`
  return (
    <Box
      gridColumn="1 / -1"
      bg={SEMANTIC_COLORS.bgTertiary}
      p={SPACING_PATTERNS.cardPadding}
      borderLeft="2px solid"
      borderColor={SEMANTIC_COLORS.success}
    >
      <VStack align="flex-start" spacing={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
          wordBreak="break-all"
        >
          {venue} · {CHAIN_NAME[r.chain] ?? r.chain} · {r.owner}
          {r.marketId ? ` · market ${r.marketId}` : ''}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textSecondary}
          lineHeight="1.9"
        >
          At its first liquidation ({minuteClock(r.t0Minute)}) it held {legs(r.coll)} against{' '}
          {legs(r.debt)}, at {pct(r.ltv0, 2)} LTV against its own {pct(r.line, 2)} liquidation line.{' '}
          {r.priced ? (
            <>
              The protocol liquidated it {times}, repaying {usd(r.realRepaidUsd)}
              {r.realFrac != null ? ` — ${pct(r.realFrac)} of the debt` : ''}
              {r.realBadDebtUsd > 0
                ? ` (and wrote off ${usd(r.realBadDebtUsd)} as bad debt)`
                : ''}.{' '}
              {r.sales === 0 ? (
                <>Membrane&rsquo;s walk never sold it†: nothing repaid.</>
              ) : (
                <>
                  Membrane&rsquo;s walk would have repaid {usd(r.memRepaidUsd)}†
                  {r.memFrac != null ? ` — ${pct(r.memFrac)}` : ''} in{' '}
                  {r.sales === 1 ? 'one sale' : `${r.sales} sales`}
                  {r.firstSaleMinute != null
                    ? `, the first at ${minuteClock(r.firstSaleMinute)}`
                    : ''}
                  .
                </>
              )}
            </>
          ) : (
            <>
              The protocol liquidated it {times}. Its loan token has no USD price that day, so it is
              in no dollar figure on either side; Membrane&rsquo;s walk made{' '}
              {r.sales === 1 ? 'one sale' : `${r.sales} sales`}†.
            </>
          )}
        </Text>
        {r.gridEndUsd != null ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.warning}
            lineHeight="1.9"
          >
            {GRID_END_MARK} Its 8-hour window was still open when the data ends (23:59 UTC 11 Oct).
            That is not a completed sale; the census books it at the last price, {usd(r.gridEndUsd)}
            †, the conservative choice.
          </Text>
        ) : null}
        {r.cure && !r.cure.noWindow ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={cureState(r).color}
            lineHeight="1.9"
          >
            {r.cure.curedInWindow
              ? `On price alone it was back under its line inside the window, lowest ${r.cure.minutesToCure} minutes after the first liquidation (${pct(r.cure.bestLtv, 2)})` +
                (r.cure.healthyAt8h
                  ? ', and still under it at the 8-hour mark.'
                  : `, but back over it by hour 8 (${pct(r.cure.endLtv, 2)}). The window delays a sale; it does not cancel it.`)
              : `On price alone it never got back under its line inside 8 hours — the lowest LTV was ${pct(r.cure.bestLtv, 2)} against ${pct(r.line, 2)}. Membrane repays to cap here; it does not save the position.`}
          </Text>
        ) : (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
          >
            {r.cure?.noWindow
              ? 'No 8-hour window: stablecoin collateral, or a line above 90%, is repaid the minute it is over its line†.'
              : 'No minute of data left after its first liquidation, so there is no window to read.'}
          </Text>
        )}
      </VStack>
    </Box>
  )
}

/**
 * The traversable cohort: every position of the census, filterable and sortable.
 *
 * Caps at 100 rendered rows, and says so in the footer rather than silently truncating — a
 * table that quietly shows the top slice reads as "this is everything" when it is not.
 */
export const CohortLens: React.FC<{ rows: CohortRow[] }> = ({ rows }) => {
  const [asset, setAsset] = useState('all')
  const [chain, setChain] = useState('all')
  const [protocol, setProtocol] = useState<ProtocolFilter>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [sort, setSort] = useState<SortKey>('debtUsd')
  const [open, setOpen] = useState<string | null>(null)

  const facets = useFacets(rows)
  const { visible, total, matched } = useCohort(rows, {
    asset,
    chain,
    protocol,
    outcome,
    sort,
    limit: PAGE,
  })

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <HStack spacing={SPACING.md} flexWrap="wrap">
        <Select
          {...selectProps}
          w="auto"
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as ProtocolFilter)}
          aria-label="Filter by protocol"
        >
          <option value="all">Aave and Morpho</option>
          <option value="aave">Aave V3</option>
          <option value="morpho">Morpho Blue</option>
        </Select>
        <Select
          {...selectProps}
          w="auto"
          value={asset}
          onChange={(e) => setAsset(e.target.value)}
          aria-label="Filter by collateral asset"
        >
          <option value="all">all collateral</option>
          {facets.assets.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          {...selectProps}
          w="auto"
          value={chain}
          onChange={(e) => setChain(e.target.value)}
          aria-label="Filter by chain"
        >
          <option value="all">all chains</option>
          {facets.chains.map((c) => (
            <option key={c} value={c}>
              {CHAIN_NAME[c] ?? c}
            </option>
          ))}
        </Select>
        <Select
          {...selectProps}
          w="auto"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as OutcomeFilter)}
          aria-label="Filter by outcome"
        >
          <option value="all">every outcome</option>
          <option value="membraneLess">Membrane closes less</option>
          <option value="membraneMore">Membrane worse</option>
          <option value="equal">equal to the cent</option>
          <option value="cured">cured in 8h</option>
          <option value="notCured">never cured</option>
          <option value="gridEnd">window open at data end</option>
        </Select>
        <Select
          {...selectProps}
          w="auto"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort rows"
        >
          <option value="debtUsd">largest debt</option>
          <option value="spared">most debt spared</option>
          <option value="events">most repeat hits</option>
          <option value="ltv0">highest LTV</option>
        </Select>
      </HStack>

      <Box overflowX="auto">
        <Box minW="820px">
          <Grid
            templateColumns={COLS}
            gap={SPACING.md}
            pb={SPACING.sm}
            borderBottom="1px solid"
            borderColor={SEMANTIC_COLORS.borderMedium}
          >
            {['Position', 'Debt', 'LTV / line', 'Protocol', 'Membrane†', 'Spared', 'Cured'].map(
              (h) => (
                <HStack key={h} spacing={SPACING.none} align="center">
                  <Eyebrow>{h}</Eyebrow>
                  {h === 'Cured' ? <InfoTip term="Cured" label={CURE_LEGEND} /> : null}
                </HStack>
              ),
            )}
          </Grid>

          {visible.map((r) => {
            const spared = sparedUsd(r)
            const isOpen = open === r.id
            const cs = cureState(r)
            return (
              <React.Fragment key={r.id}>
                <Grid
                  templateColumns={COLS}
                  gap={SPACING.md}
                  py={SPACING.md}
                  borderBottom="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  alignItems="center"
                  cursor="pointer"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  transition={TRANSITIONS.colors}
                  _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                  _focus={FOCUS_STYLES.ring}
                  onClick={() => setOpen(isOpen ? null : r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpen(isOpen ? null : r.id)
                    }
                  }}
                >
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {r.primary}
                    {r.coll.length > 1 ? `+${r.coll.length - 1}` : ''}/{r.debt[0]?.[0] ?? '?'}
                    {r.debt.length > 1 ? `+${r.debt.length - 1}` : ''}
                    {r.events > 1 ? (
                      <Text as="span" color={SEMANTIC_COLORS.warning}>
                        {' '}
                        ×{r.events}
                      </Text>
                    ) : null}
                    <Text as="span" color={SEMANTIC_COLORS.textTertiary} fontSize={TYPOGRAPHY.xs}>
                      {' '}
                      {r.protocol === 'aave' ? 'Aave' : 'Morpho'} · {CHAIN_NAME[r.chain] ?? r.chain}
                    </Text>
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    {r.debtUsd == null ? 'unpriced' : usd(r.debtUsd)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    {pct(r.ltv0, 1)} / {pct(r.line, 1)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.danger}
                  >
                    {r.realFrac == null ? '—' : pct(r.realFrac)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.success}
                  >
                    {r.memFrac == null ? '—' : pct(r.memFrac)}
                    {r.gridEndUsd != null ? (
                      <Text as="span" color={SEMANTIC_COLORS.warning}>
                        {' '}
                        {GRID_END_MARK}
                      </Text>
                    ) : null}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={
                      spared == null
                        ? SEMANTIC_COLORS.textTertiary
                        : spared >= 0
                          ? SEMANTIC_COLORS.success
                          : SEMANTIC_COLORS.danger
                    }
                  >
                    {spared == null ? '—' : spared >= 0 ? usd(spared) : `−${usd(-spared)}`}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={cs.color}
                  >
                    {cs.text}
                  </Text>
                </Grid>
                {isOpen ? <Detail r={r} /> : null}
              </React.Fragment>
            )
          })}
        </Box>
      </Box>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
        lineHeight="1.7"
      >
        Showing {visible.length.toLocaleString('en-US')} of {matched.toLocaleString('en-US')}{' '}
        matching
        {matched !== total ? ` (${total.toLocaleString('en-US')} total)` : ''}. Rows are capped at{' '}
        {PAGE} — narrow the filters to reach the rest. &ldquo;Protocol&rdquo; and
        &ldquo;Membrane&rdquo; are the share of the debt at the first liquidation each closes;
        &ldquo;Spared&rdquo; is what the protocol repaid minus what Membrane would have, negative
        where Membrane closes more. {GRID_END_MARK} = the 8-hour window was still open when the data
        ends, booked as sold at the last price†. &ldquo;Cured&rdquo;: yes = back under the line and
        still under it at 8h, 8h = back under then over again, no = never back under, — = no window.
        Click any row.
      </Text>
    </VStack>
  )
}
