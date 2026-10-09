import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { ConfigCardView } from '@/lib/oracleRegistry/config/apiTypes'

import { BlockTitle, BreachLine, Chip, ExtLink, Holders, ItemLine } from './ConfigAtoms'
import { ConfigBridge } from './ConfigBridge'
import { ConfigTimeline } from './ConfigTimeline'
import {
  announcementChip,
  asOfLine,
  blockAside,
  breachBannerTitle,
  delayText,
  hasFloorRoutes,
  headline,
  headlineTone,
  NO_WINDOW_TITLE,
  oracleAside,
  RED_META,
  smallText,
  sourcesLine,
  STATE_META,
} from './configViewModel'

// One asset's trust configuration (design §6): a headline, a persistent red banner for every
// state rule failing now, the four dimensions (bridge routes incl. the remote side, oracles,
// admin powers, mint/redeem) and the change timeline. Read from the config collector's files
// via /api/oracles/[asset]?view=config.

const CLASS_LABEL: Record<ConfigCardView['class'], string> = {
  lrt: 'LRT',
  bridged: 'bridged',
  pt: 'PT',
  custodial: 'custodial',
}

const Block: React.FC<{ children: React.ReactNode; span?: boolean }> = ({ children, span }) => (
  <Box
    gridColumn={span ? '1 / -1' : undefined}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    bg={SEMANTIC_COLORS.bgSecondary}
    p={SPACING.md}
    minW={0}
  >
    {children}
  </Box>
)

export const ConfigCard: React.FC<{
  view: ConfigCardView
  now: number | null
  onShowOracles: (() => void) | null
  onLoadAll: () => void
  loadingAll: boolean
}> = ({ view, now, onShowOracles, onLoadAll, loadingAll }) => {
  const asOf = asOfLine(view.asOf, now)
  const ann = announcementChip({ announcement: view.announcement, unannounced: null })
  const floor = view.breaches.filter((b) => b.ruleId === 'BR-2')
  const rule = view.breaches.filter((b) => b.ruleId !== 'BR-2')
  const tone = headlineTone(view.available, view.changesAvailable, view.counts.openRed)
  return (
    <Box as="article" aria-labelledby="config-title" mt={SPACING.lg}>
      {/* ---- header -------------------------------------------------------------------------- */}
      <Box display="flex" flexWrap="wrap" alignItems="baseline" columnGap={SPACING.sm} rowGap="4px">
        <Text
          id="config-title"
          as="h2"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h2}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {view.label}
        </Text>
        <Chip loud={false}>{CLASS_LABEL[view.class]}</Chip>
      </Box>
      <Text
        mt="4px"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={
          tone === 'red'
            ? RED_META.text
            : tone === 'warning'
              ? SEMANTIC_COLORS.warning
              : SEMANTIC_COLORS.textPrimary
        }
        aria-live="polite"
      >
        {tone === 'warning' && <span aria-hidden="true">? </span>}
        {tone === 'red' && <span aria-hidden="true">{RED_META.glyph} </span>}
        {headline(
          view.symbol,
          view.counts,
          view.available,
          view.changesAvailable,
          hasFloorRoutes(view.bridge),
        )}
      </Text>
      <Box
        mt="4px"
        display="flex"
        flexWrap="wrap"
        alignItems="center"
        gap="6px"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.textSecondary}
      >
        <Text as="span">{asOf.text}</Text>
        {asOf.stale && (
          <Chip
            token={SEMANTIC_COLORS.warning}
            glyph="░"
            title="Collector output is older than 48 hours: recent changes may be missing"
          >
            STALE
          </Chip>
        )}
        {!view.available && <Chip token={SEMANTIC_COLORS.warning}>NOT COLLECTED</Chip>}
        {ann && (
          <Chip token={SEMANTIC_COLORS.textSecondary} title={ann.title}>
            {ann.label}
          </Chip>
        )}
        {view.govChannels.map((g) => (
          <ExtLink key={g.url} href={g.url}>
            {g.label} ↗
          </ExtLink>
        ))}
      </Box>
      {view.proposedSources.length > 0 && (
        <Text
          mt="2px"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={SEMANTIC_COLORS.textSecondary}
        >
          proposed sources · {sourcesLine(view.proposedSources, view.announcement)}
        </Text>
      )}

      {/* effective delay per power (shortest over every holder path) */}
      {view.delays.length > 0 && (
        <Box
          mt={SPACING.sm}
          display="flex"
          flexWrap="wrap"
          columnGap={SPACING.base}
          rowGap="4px"
          aria-label="Effective delay per power"
        >
          {view.delays.map((d) => {
            const t = delayText(d)
            return (
              <Box key={d.power} display="inline-flex" alignItems="baseline" gap="6px">
                <Text
                  as="span"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="10px"
                  letterSpacing="0.2em"
                  textTransform="uppercase"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {t.key}
                </Text>
                <Text
                  as="span"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  {t.value}
                </Text>
                {t.noWindow && (
                  <Chip loud={false} title={NO_WINDOW_TITLE}>
                    no pending window
                  </Chip>
                )}
              </Box>
            )
          })}
        </Box>
      )}

      {/* ---- reads that failed and can hide a red flag (the headline is hedged over them) ---- */}
      {(view.readGaps ?? []).length > 0 && (
        <Box
          mt={SPACING.sm}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={SEMANTIC_COLORS.warning}
          aria-label="Reads that failed"
        >
          <Text>
            <span aria-hidden="true">! </span>
            {(view.readGaps ?? []).length} {(view.readGaps ?? []).length === 1 ? 'read' : 'reads'}{' '}
            failed — red flags may be missing:
          </Text>
          {(view.readGaps ?? []).map((g) => (
            <Text key={g} pl="12px" wordBreak="break-word">
              {g}
            </Text>
          ))}
        </Box>
      )}

      {/* ---- persistent red banner: state rules failing NOW (no change event needed) ---------- */}
      {view.breaches.length > 0 && (
        <Box
          // a region, not an alert (review round 7): the persistent banner was announced twice
          // with the aria-live headline that already states the breaches
          role="region"
          aria-label="Rules failing now"
          mt={SPACING.md}
          p={SPACING.md}
          border="1px solid"
          borderColor={RED_META.token}
          borderLeftWidth="3px"
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11px"
            letterSpacing="0.16em"
            color={RED_META.text}
            mb="4px"
          >
            <span aria-hidden="true">{RED_META.glyph} </span>
            {/* KG-2: routes like the headline, sides in brackets */}
            {breachBannerTitle(view.counts.floorBreaches, floor.length, rule.length)}
          </Text>
          {view.breaches.map((b, i) => (
            <BreachLine key={`${b.key}-${b.ruleId}-${i}`} b={b} rule={view.rules[b.ruleId]} />
          ))}
        </Box>
      )}

      {/* ---- dimensions --------------------------------------------------------------------- */}
      <Grid
        mt={SPACING.md}
        templateColumns={{ base: '1fr', lg: 'repeat(3, minmax(0, 1fr))' }}
        gap={SPACING.md}
        alignItems="start"
      >
        <Block span>
          <ConfigBridge bridge={view.bridge} rules={view.rules} available={view.available} />
        </Block>

        <Block>
          <Box as="section" aria-labelledby="config-oracle">
            <BlockTitle id="config-oracle" aside={oracleAside(view.oracle)}>
              Oracles
            </BlockTitle>
            {view.oracle.oracleSlug ? (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                {view.oracle.entries} oracle {view.oracle.entries === 1 ? 'card' : 'cards'} ·{' '}
                {onShowOracles ? (
                  <Box
                    as="button"
                    type="button"
                    onClick={onShowOracles}
                    textDecoration="underline"
                    color={SEMANTIC_COLORS.textPrimary}
                    _hover={{ color: SEMANTIC_COLORS.primary }}
                    _focusVisible={FOCUS_STYLES.ring}
                  >
                    open the oracle view
                  </Box>
                ) : (
                  'see the oracle view'
                )}
              </Text>
            ) : (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                not in the oracle catalog — config only
              </Text>
            )}
          </Box>
        </Block>

        <Block>
          <Box as="section" aria-labelledby="config-admin">
            <BlockTitle
              id="config-admin"
              aside={blockAside(view.available, view.admin.powers.length, 'power')}
            >
              Admin
            </BlockTitle>
            {view.admin.powers.map((p, i) => (
              <Box
                key={`${p.power}-${p.label}-${i}`}
                py="4px"
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
              >
                <Box
                  display="flex"
                  justifyContent="space-between"
                  gap={SPACING.sm}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11px"
                >
                  <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                    {p.breaches.length > 0 && (
                      <Text as="span" color={RED_META.text} aria-hidden="true">
                        {RED_META.glyph}{' '}
                      </Text>
                    )}
                    {p.label}
                  </Text>
                  <Text
                    as="span"
                    whiteSpace="nowrap"
                    color={SEMANTIC_COLORS.textPrimary}
                    title={p.pendingNote ?? (p.pendingObservable ? undefined : 'no pending window')}
                  >
                    {p.delayLabel}
                    {!p.pendingObservable && (
                      <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
                        {' '}
                        · no window
                      </Text>
                    )}
                  </Text>
                </Box>
                {p.pendingNote && (
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="11px"
                    color={SEMANTIC_COLORS.textSecondary}
                    wordBreak="break-word"
                  >
                    {p.pendingNote}
                  </Text>
                )}
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11px"
                  color={SEMANTIC_COLORS.textSecondary}
                  wordBreak="break-word"
                >
                  <Holders holders={p.holders} />
                </Text>
                {p.breaches.map((b) => (
                  <BreachLine key={`${b.ruleId}-${b.message}`} b={b} rule={view.rules[b.ruleId]} />
                ))}
                {/* the engine's notes (review round 6): which whitelisted functions bypass the
                    timelock and who holds the bypass, a holder not classified at head */}
                {p.warnings.map((w) => (
                  <Text
                    key={w}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="11px"
                    color={SEMANTIC_COLORS.textSecondary}
                    wordBreak="break-word"
                  >
                    <span aria-hidden="true">· </span>
                    {w}
                  </Text>
                ))}
              </Box>
            ))}
            {view.admin.items.map((i, n) => (
              <ItemLine key={`${i.key}-${n}`} i={i} rules={view.rules} />
            ))}
          </Box>
        </Block>

        <Block>
          <Box as="section" aria-labelledby="config-mint">
            <BlockTitle
              id="config-mint"
              aside={blockAside(view.available, view.mint.items.length, 'setting')}
            >
              Mint / redeem
            </BlockTitle>
            {view.mint.items.length ? (
              view.mint.items.map((i, n) => (
                <ItemLine key={`${i.key}-${n}`} i={i} rules={view.rules} />
              ))
            ) : (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                {view.available ? 'no mint / redeem getters read' : 'not collected'}
              </Text>
            )}
          </Box>
        </Block>
      </Grid>

      <ConfigTimeline view={view} now={now} onLoadAll={onLoadAll} loadingAll={loadingAll} />

      {/* ---- cold tier: how to read it, sources, gaps ---------------------------------------- */}
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
          Method · rules · gaps
        </Box>
        <Box as="ul" pl={SPACING.base} mt={SPACING.sm} lineHeight={1.6}>
          <li>
            States:{' '}
            <Text as="span" color={smallText(STATE_META.pending.token)}>
              {STATE_META.pending.glyph} pending
            </Text>{' '}
            (queued in a timelock, or submitted to an on-chain multisig and not executed),{' '}
            <Text as="span" color={smallText(STATE_META.proposed.token)}>
              {STATE_META.proposed.glyph} proposed
            </Text>{' '}
            (Safe queue),{' '}
            <Text as="span" color={smallText(STATE_META.historical.token)}>
              {STATE_META.historical.glyph} historical
            </Text>{' '}
            (executed), {STATE_META.stale.glyph} stale (past ETA, cannot execute).{' '}
            <Text as="span" color={RED_META.text}>
              {RED_META.glyph} red
            </Text>{' '}
            = a downgrade or a floor breach, in any state.
          </li>
          <li>
            E = distinct known DVN operators an attacker must compromise on that side. Floor: a live
            route with E under 2 is red, including when it is created. Measured from on-chain reads
            at the block above; operator names come from LayerZero metadata.
          </li>
          <li>
            Announcements: no governance source is ingested in v1, so no change is marked announced
            or unannounced.
          </li>
          {Object.entries(view.rules).map(([id, text]) => (
            <li key={id}>
              {id}: {text}
            </li>
          ))}
          {view.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {view.warnings.map((w) => (
            <li key={w}>? {w}</li>
          ))}
          {view.proposedSources
            .filter((p) => p.note)
            .map((p) => (
              <li key={`${p.kind}-${p.note}`}>
                {p.kind.replace(/_/g, ' ')}: {p.note}
              </li>
            ))}
          <li>
            {view.available ? (
              <>
                History scanned from block {view.scan.from.toLocaleString('en-US')} to{' '}
                {view.scan.to.toLocaleString('en-US')}.
              </>
            ) : (
              'History not collected for this subject: no scan has run.'
            )}
          </li>
        </Box>
      </Box>
    </Box>
  )
}

export default ConfigCard
