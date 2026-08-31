import { Box, Grid, HStack, Select, Text, VStack } from '@chakra-ui/react'
import React, { useState } from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { CURE_LEGEND, Eyebrow, InfoTip, pct, usd } from './atoms'
import { useCohort, useFacets } from './useEvidence'
import { CohortRow, OutcomeFilter, SortKey, sparedUsd } from './types'

const COLS = '1.1fr 0.9fr 0.7fr 0.8fr 0.8fr 0.9fr 0.7fr'
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

/** Expanded detail for one account. Opens in place under its row. */
const Detail: React.FC<{ r: CohortRow }> = ({ r }) => (
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
        {r.chain} · {r.user}
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={SEMANTIC_COLORS.textSecondary}
        lineHeight="1.9"
      >
        Held {usd(r.collateralUsd)} of {r.collSymbol} against {usd(r.debtUsd)} of{' '}
        {r.debtSymbol}, at {pct(r.ltv0, 2)} LTV against its own {pct(r.liqLine, 2)} liquidation
        line (health factor {r.healthFactor.toFixed(4)}).{' '}
        {r.events === 1
          ? 'Aave liquidated it once'
          : `Aave liquidated it ${r.events} separate times`}
        , closing {usd(r.aaveClosedUsd)} — {pct(r.aaveClosedFrac)} of the debt. Membrane&rsquo;s
        repay-to-cap would have closed {usd(r.membraneClosedUsd)} — {pct(r.membraneClosedFrac)}.
      </Text>
      {r.cure ? (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={
            r.cure.healthyAt8h
              ? SEMANTIC_COLORS.success
              : r.cure.curedInWindow
                ? SEMANTIC_COLORS.warning
                : SEMANTIC_COLORS.danger
          }
          lineHeight="1.9"
        >
          {r.cure.curedInWindow
            ? `Price brought it back under the line after ${r.cure.minutesToCure} minutes` +
              (r.cure.healthyAt8h
                ? ', and it was still healthy at the 8-hour mark. Under an 8h cure window this liquidation does not happen.'
                : `, but it was back above the line by hour 8 (${pct(r.cure.endLtv, 2)}). The window delays the sale; it does not cancel it.`)
            : `It never recovered inside 8 hours — best LTV in the window was ${pct(r.cure.bestLtv, 2)} against a ${pct(r.liqLine, 2)} line. Membrane repays to cap here; it does not save the position.`}
        </Text>
      ) : (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          Cure analysis unavailable — the Oct 10 oracle series does not price {r.collSymbol}.
        </Text>
      )}
    </VStack>
  </Box>
)

/**
 * The traversable cohort. 2,350 real accounts, filterable and sortable.
 *
 * Caps at 100 rendered rows, and says so in the footer rather than silently
 * truncating — a table that quietly shows the top slice reads as "this is
 * everything" when it is not.
 */
export const CohortLens: React.FC<{ rows: CohortRow[] }> = ({ rows }) => {
  const [asset, setAsset] = useState('all')
  const [chain, setChain] = useState('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [sort, setSort] = useState<SortKey>('debtUsd')
  const [open, setOpen] = useState<string | null>(null)

  const facets = useFacets(rows)
  const { visible, total, matched } = useCohort(rows, {
    asset,
    chain,
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
              {c}
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
          <option value="cured">cured in 8h</option>
          <option value="notCured">never cured</option>
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
            {['Position', 'Debt', 'LTV / line', 'Aave closed', 'Membrane', 'Spared', 'Cured'].map(
              (h) => (
                <HStack key={h} spacing={SPACING.none} align="center">
                  <Eyebrow>{h}</Eyebrow>
                  {h === 'Cured' ? (
                    <InfoTip term="Cured" label={CURE_LEGEND} />
                  ) : null}
                </HStack>
              ),
            )}
          </Grid>

          {visible.map((r) => {
            const id = `${r.chain}:${r.user}`
            const spared = sparedUsd(r)
            const isOpen = open === id
            return (
              <React.Fragment key={id}>
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
                  onClick={() => setOpen(isOpen ? null : id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpen(isOpen ? null : id)
                    }
                  }}
                >
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {r.collSymbol}/{r.debtSymbol}
                    {r.events > 1 ? (
                      <Text as="span" color={SEMANTIC_COLORS.warning}>
                        {' '}
                        ×{r.events}
                      </Text>
                    ) : null}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    {usd(r.debtUsd)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    {pct(r.ltv0, 1)} / {pct(r.liqLine, 1)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.danger}
                  >
                    {pct(r.aaveClosedFrac)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.success}
                  >
                    {pct(r.membraneClosedFrac)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={spared >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
                  >
                    {spared >= 0 ? usd(spared) : `−${usd(-spared)}`}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={
                      !r.cure
                        ? SEMANTIC_COLORS.textTertiary
                        : r.cure.healthyAt8h
                          ? SEMANTIC_COLORS.success
                          : r.cure.curedInWindow
                            ? SEMANTIC_COLORS.warning
                            : SEMANTIC_COLORS.danger
                    }
                  >
                    {!r.cure ? '—' : r.cure.healthyAt8h ? 'yes' : r.cure.curedInWindow ? '8h' : 'no'}
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
        Showing {visible.length.toLocaleString()} of {matched.toLocaleString()} matching
        {matched !== total ? ` (${total.toLocaleString()} total)` : ''}. Rows are capped at{' '}
        {PAGE} — narrow the filters to reach the rest. &ldquo;Spared&rdquo; is what Aave closed
        minus what Membrane would have; negative means Membrane closes more. &ldquo;Cured&rdquo;:
        yes = recovered and still healthy at 8h, 8h = recovered then breached again, no = never
        recovered, — = collateral not priceable. Click any row.
      </Text>
    </VStack>
  )
}
