// The gauntlet stage: floor header, mechanism explainer, pre-floor forecast card,
// forecast result, the running ticker, the per-venue audit receipt (+ settlement +
// "where these numbers come from"), the roads-not-taken table, and Continue/Retry.
// Proto: #stage2 markup (:501-538), renderAudit (:1292), askForecast/fcres (:1507-1566),
// renderGhosts (:1862), resolveFloor copy (:1901-2007).

import React from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { CLASS_COLOR, CLASS_NM, MAX_BORROW } from './fixtures'
import { Stage } from './hooks/useBuilderEngine'
import { TINTS, tabular } from './styles'
import { usd } from './utils'
import { GhostRow, Resolution } from './types'

const btnSx = {
  bg: 'transparent',
  color: SEMANTIC_COLORS.textPrimary,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10.5px',
  letterSpacing: '0.14em',
  textTransform: 'uppercase' as const,
  h: 'auto',
  py: SPACING.md,
  px: SPACING.sm,
  transition: TRANSITIONS.colors,
  _hover: { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success, bg: 'transparent' },
  _active: { opacity: 0.85 },
  _focus: FOCUS_STYLES.ring,
}

const goldBtnSx = {
  ...btnSx,
  bg: SEMANTIC_COLORS.warning,
  borderColor: SEMANTIC_COLORS.warning,
  color: SEMANTIC_COLORS.bgPrimary,
  _hover: { bg: SEMANTIC_COLORS.warning, opacity: 0.9 },
}

interface InfoDetailsProps {
  title: string
  sr: string
  children: React.ReactNode
}

/** Serif-titled collapsible explainer (proto .info). */
export const InfoDetails: React.FC<InfoDetailsProps> = ({ title, sr, children }) => (
  <Box as="details" my={SPACING.sm} sx={{ '& > summary::-webkit-details-marker': { display: 'none' } }}>
    <Box as="summary" listStyleType="none" cursor="pointer" display="flex" alignItems="center" gap={SPACING.sm}>
      <Text as="span" fontFamily={TYPOGRAPHY.fontDisplay} fontSize="19px" color={SEMANTIC_COLORS.textPrimary}>
        {title}
      </Text>
      <Box
        as="i"
        aria-hidden="true"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontStyle="italic"
        fontSize="10px"
        w="15px"
        h="15px"
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        color={SEMANTIC_COLORS.textSecondary}
        display="grid"
        placeItems="center"
      >
        i
      </Box>
      <Box as="span" position="absolute" w="1px" h="1px" overflow="hidden" sx={{ clip: 'rect(0 0 0 0)' }} whiteSpace="nowrap">
        {sr}
      </Box>
    </Box>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="12px"
      color={SEMANTIC_COLORS.textSecondary}
      lineHeight={1.75}
      mt={SPACING.sm}
      borderLeft="2px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      pl={SPACING.md}
      maxW="92ch"
    >
      {children}
    </Text>
  </Box>
)

const AuditTable: React.FC<{ stage: Stage }> = ({ stage }) => {
  const a = stage.audit
  if (!a) return null
  const needed = stage.auditNeeded
  const soldBtc = stage.auditSold
  const gap = Math.max(0, needed - a.recalled)
  const applied = Math.min(a.recalled, needed)
  const hd = {
    fontFamily: TYPOGRAPHY.fontMono,
    fontSize: '8.5px',
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    color: SEMANTIC_COLORS.textSecondary,
  }
  const cell = { fontFamily: TYPOGRAPHY.fontMono, fontSize: '11px' }
  const cols = { base: '1fr 78px 84px', md: '1.4fr 84px 66px 62px 84px 1.9fr' }
  return (
    <Box mt={SPACING.md} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      <Box display="grid" gridTemplateColumns={cols} gap={SPACING.sm} px={SPACING.md} py={SPACING.sm} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} bg={SEMANTIC_COLORS.bgTertiary} alignItems="center">
        <Text {...hd}>Venue</Text>
        <Text {...hd} textAlign="right" display={{ base: 'none', md: 'block' }}>
          Held
        </Text>
        <Text {...hd} textAlign="right" display={{ base: 'block', md: 'block' }}>
          Haircut
        </Text>
        <Text {...hd} textAlign="right" display={{ base: 'none', md: 'block' }}>
          Liquid
        </Text>
        <Text {...hd} textAlign="right">
          Returned
        </Text>
        <Text {...hd} display={{ base: 'none', md: 'block' }}>
          Why
        </Text>
      </Box>
      {a.rows.map((r, i) => (
        <Box key={i} display="grid" gridTemplateColumns={cols} gap={SPACING.sm} px={SPACING.md} py={SPACING.sm} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} alignItems="center">
          <Box {...cell} color={SEMANTIC_COLORS.textPrimary} boxShadow={`inset 3px 0 0 ${CLASS_COLOR[r.t.cls]}`} pl={SPACING.sm}>
            {r.t.nm}
            <Text as="span" display="block" fontSize="8.5px" letterSpacing="0.14em" textTransform="uppercase" color={CLASS_COLOR[r.t.cls]}>
              {CLASS_NM[r.t.cls]}
            </Text>
          </Box>
          <Text {...cell} {...tabular} textAlign="right" color={SEMANTIC_COLORS.textSecondary} display={{ base: 'none', md: 'block' }}>
            {usd(r.share)}
          </Text>
          <Text {...cell} {...tabular} textAlign="right" color={SEMANTIC_COLORS.textSecondary}>
            {r.hair || r.bleed ? '−' + ((r.hair + r.bleed) * 100).toFixed(0) + '%' + (r.bleed ? '*' : '') : '—'}
          </Text>
          <Text {...cell} {...tabular} textAlign="right" color={SEMANTIC_COLORS.textSecondary} display={{ base: 'none', md: 'block' }}>
            {(r.liq * 100).toFixed(0)}%
          </Text>
          <Text {...cell} {...tabular} textAlign="right" color={r.ret <= 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textSecondary}>
            {a.stale ? (
              <>
                <Text as="span" color={SEMANTIC_COLORS.warning}>
                  {usd(r.shown)}
                </Text>{' '}
                → {usd(r.ret)}
              </>
            ) : (
              usd(r.ret)
            )}
          </Text>
          <Text {...cell} fontSize="10px" lineHeight={1.45} color={r.ret <= 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textTertiary} gridColumn={{ base: '1 / -1', md: 'auto' }}>
            {r.why}
          </Text>
        </Box>
      ))}
      <Box display="grid" gridTemplateColumns={cols} gap={SPACING.sm} px={SPACING.md} py={SPACING.sm} bg={SEMANTIC_COLORS.bgTertiary} alignItems="center">
        <Text {...cell} color={SEMANTIC_COLORS.textPrimary}>
          Total recallable
        </Text>
        <Box display={{ base: 'none', md: 'block' }} />
        <Box />
        <Box display={{ base: 'none', md: 'block' }} />
        <Text {...cell} {...tabular} textAlign="right" color={SEMANTIC_COLORS.textPrimary}>
          {usd(a.recalled)}
        </Text>
        <Text {...cell} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} gridColumn={{ base: '1 / -1', md: 'auto' }}>
          {needed <= 0
            ? 'you stayed under the line, so none of this was called for. It is what would have been there.'
            : 'available across your venues in total'}
        </Text>
      </Box>
      {needed > 0 && (
        <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr auto 1fr auto 1fr' }} gap={{ base: SPACING.sm, md: SPACING.md }} alignItems="center" px={SPACING.md} py={SPACING.base} bg={SEMANTIC_COLORS.bgTertiary} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderStrong}>
          <Box display="grid" gap="4px" minW={0}>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
              Debt liquidated
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="18px" {...tabular} color={SEMANTIC_COLORS.textPrimary}>
              {usd(needed)}
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textSecondary}>
              to get back to the {(MAX_BORROW * 100).toFixed(0)}% cap
            </Text>
          </Box>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="16px" color={SEMANTIC_COLORS.textTertiary} display={{ base: 'none', md: 'block' }}>
            −
          </Text>
          <Box display="grid" gap="4px" minW={0}>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
              Recalled from venues
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="18px" {...tabular} color={SEMANTIC_COLORS.textPrimary}>
              {usd(applied)}
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textSecondary}>
              {a.recalled > needed ? 'of ' + usd(a.recalled) + ' available' : 'everything they could send'}
            </Text>
          </Box>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="16px" color={SEMANTIC_COLORS.textTertiary} display={{ base: 'none', md: 'block' }}>
            =
          </Text>
          <Box display="grid" gap="4px" minW={0}>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
              Sold as bitcoin
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="18px" {...tabular} color={gap > 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success}>
              {gap > 0 ? usd(gap) : '$0'}
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textSecondary}>
              {gap > 0 ? soldBtc.toFixed(3) + ' BTC out of your stack' : 'your stack was not touched'}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

const HowTo: React.FC = () => (
  <Box as="details" mt={SPACING.sm} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} bg={SEMANTIC_COLORS.bgTertiary} sx={{ '& > summary::-webkit-details-marker': { display: 'none' }, '& > summary::before': { content: '"+ "', color: SEMANTIC_COLORS.textTertiary }, '&[open] > summary::before': { content: '"− "' } }}>
    <Box as="summary" px={SPACING.md} py={SPACING.sm} cursor="pointer" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.success} listStyleType="none">
      Where these numbers come from
    </Box>
    <Box px={SPACING.md} pb={SPACING.md} display="grid" gap={SPACING.sm} fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.65}>
      <Text>
        Every figure above comes from the same read the liquidation engine uses. It walks the position’s registered venues and asks
        each one what it can actually deliver right now — not what it holds on paper.
      </Text>
      {[
        ['retrievableCdt(user)', '= min( convertToAssets(your shares) , pool-wide liquid )'],
        ['pool-wide liquid', '= idleLedger + cdtBufferLedger + _venueLiquidSafe()'],
        ['_venueLiquidSafe()', ' is gas-capped and try/caught. If the venue’s own view reverts or runs out of gas it returns 0 — an unreadable venue counts as illiquid, never as full.'],
        ['per venue', ': Aave min(aToken.balanceOf(this), underlying.balanceOf(aToken)) — the second term is the unborrowed reserve, which is what a bank run empties · Yearn min(position, yVault idle) · sUSDe 0 while cooling · ERC-4626 min(maxWithdraw, previewRedeem)'],
        ['the recall itself', ' measures balance-delta on the engine, so a venue that claims to have sent funds but did not is recorded as having sent nothing.'],
      ].map(([b, rest]) => (
        <Box key={b} borderLeft="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pl={SPACING.sm} display="grid" gap="2px">
          <Text>
            <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.textPrimary}>
              {b}
            </Text>
            {rest}
          </Text>
        </Box>
      ))}
      <Text color={SEMANTIC_COLORS.textTertiary}>
        A haircut marked <Box as="code" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.info} fontSize="10.5px">*</Box> is a
        real bleed — principal that is gone. An unmarked one is a dislocation: it only costs you if the collateral move forces a
        recall while the peg is off, otherwise it recovers and you paid nothing. Haircuts are the other half: a depeg reduces what
        your shares are <Box as="em">worth</Box> before liquidity is even asked about. That loss is real whether or not you are
        liquidated.
      </Text>
    </Box>
  </Box>
)

const Ghosts: React.FC<{ rows: GhostRow[]; playerR: Resolution; playerLabel: string; open: boolean; onToggle: () => void }> = ({ rows, playerR, playerLabel, open, onToggle }) => {
  const all: GhostRow[] = [{ label: playerLabel, R: playerR, you: true }, ...rows]
  return (
    <Box mt={SPACING.sm} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        gap={SPACING.sm}
        px={SPACING.sm}
        py="6px"
        cursor="pointer"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="9px"
        letterSpacing="0.22em"
        textTransform="uppercase"
        color={SEMANTIC_COLORS.textSecondary}
        transition={TRANSITIONS.colors}
        _hover={{ color: SEMANTIC_COLORS.textPrimary }}
        _focusVisible={FOCUS_STYLES.ring}
      >
        <Text as="span">The roads not taken · same floor, same math</Text>
        <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
          {open ? 'collapse' : 'expand'}
        </Text>
      </Box>
      {open &&
        all.map((r, i) => {
          const why =
            !r.you && r.R.survived === playerR.survived && r.R.bind.k === playerR.bind.k
              ? 'same story as yours — ' + r.R.bind.why
              : (r.R.survived ? 'survived' : 'died') + ' — ' + r.R.bind.why
          return (
            <Box key={i} display="grid" gridTemplateColumns={{ base: '1fr 62px', md: 'minmax(150px,1fr) 62px minmax(200px,2.2fr)' }} gap={SPACING.sm} px={SPACING.sm} py="3px" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" lineHeight={1.35} alignItems="baseline">
              <Text color={r.you ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}>{r.label}</Text>
              <Text fontSize="9px" letterSpacing="0.18em" color={r.R.survived ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}>
                {r.R.survived ? 'SURVIVED' : 'DIED'}
              </Text>
              <Text color={SEMANTIC_COLORS.textSecondary} {...tabular} gridColumn={{ base: '1 / -1', md: 'auto' }}>
                {why}
              </Text>
            </Box>
          )
        })}
    </Box>
  )
}

export interface GauntletStageProps {
  stage: Stage
  fcastP: number
  vet: boolean
  cfxOpen: boolean
  playerLabel: string
  onForecastP: (v: number) => void
  onLockForecast: () => void
  onSkipForecast: () => void
  onNext: () => void
  onRetry: () => void
  onToggleCfx: () => void
}

export const GauntletStage: React.FC<GauntletStageProps> = ({
  stage,
  fcastP,
  vet,
  cfxOpen,
  playerLabel,
  onForecastP,
  onLockForecast,
  onSkipForecast,
  onNext,
  onRetry,
  onToggleCfx,
}) => (
  <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} bg={TINTS.sunk} p={SPACING.base} display="grid" gap={SPACING.md} minH="150px">
    <Box display="flex" justifyContent="space-between" gap={SPACING.md} alignItems="baseline" flexWrap="wrap">
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="19px" color={SEMANTIC_COLORS.textPrimary}>
        {stage.scNm}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.warning}>
        {stage.scEra}
      </Text>
    </Box>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={SEMANTIC_COLORS.textPrimary} lineHeight={1.6}>
      {stage.scYours}
    </Text>

    {stage.mechVisible && (
      <Box as="details" mt="2px" sx={{ '& > summary::-webkit-details-marker': { display: 'none' } }}>
        <Box as="summary" listStyleType="none" cursor="pointer" display="inline-flex" alignItems="center" gap="7px" fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary} transition={TRANSITIONS.colors} _hover={{ color: SEMANTIC_COLORS.success }}>
          What this floor is doing
          <Box as="i" aria-hidden="true" fontFamily={TYPOGRAPHY.fontDisplay} fontStyle="italic" fontSize="10px" w="15px" h="15px" border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} display="grid" placeItems="center">
            i
          </Box>
        </Box>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.75} mt={SPACING.sm} borderLeft="2px solid" borderColor={SEMANTIC_COLORS.borderStrong} pl={SPACING.md} maxW="92ch">
          {stage.mechBody}
        </Text>
      </Box>
    )}

    {/* pre-floor forecast */}
    {stage.forecastVisible && (
      <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} p={SPACING.base} my={SPACING.sm}>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={SEMANTIC_COLORS.textPrimary} lineHeight={1.5}>
          {stage.fcQ}
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.xs}>
          {stage.fcSub}
        </Text>
        <Box
          as="input"
          type="range"
          min={0}
          max={100}
          step={1}
          value={fcastP}
          aria-label="Your probability that no bitcoin is sold"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onForecastP(parseInt(e.target.value, 10))}
          w="100%"
          my={SPACING.md}
          sx={{ accentColor: SEMANTIC_COLORS.warning, '&:focus-visible': { outline: `1px solid ${SEMANTIC_COLORS.success}`, outlineOffset: '2px' } }}
        />
        <Box display="flex" justifyContent="space-between" fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
          <Text as="span">certain it sells</Text>
          <Text as="span">coin flip</Text>
          <Text as="span">certain it holds</Text>
        </Box>
        <Box display="flex" alignItems="center" gap={SPACING.md} mt={SPACING.md} flexWrap="wrap">
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="32px" {...tabular} color={SEMANTIC_COLORS.warning} minW="96px" lineHeight={1}>
            {fcastP}%
          </Text>
          <Button {...goldBtnSx} flex={1} minW="150px" onClick={onLockForecast}>
            Call it &amp; run
          </Button>
          <Button {...btnSx} flex="0 1 auto" minW="130px" onClick={onSkipForecast}>
            Skip — just run it
          </Button>
        </Box>
        {!vet && (
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10.5px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.sm} lineHeight={1.6}>
            Optional, and it costs you nothing to skip. But a board that survives tells you the board was fine; it does not tell you
            whether <Box as="em">you</Box> knew it would. Calling the floor first is the only part of this that measures you rather
            than the position.
          </Text>
        )}
      </Box>
    )}

    {stage.fcResVisible && stage.fcRes && (
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" {...tabular} color={SEMANTIC_COLORS.textSecondary} borderLeft="2px solid" borderColor={SEMANTIC_COLORS.borderStrong} pl={SPACING.sm} lineHeight={1.7} my={SPACING.sm}>
        You said{' '}
        <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.textPrimary}>
          {(stage.fcRes.p * 100).toFixed(0)}%
        </Text>{' '}
        it would hold. It{' '}
        <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.textPrimary}>
          {stage.fcRes.held ? 'held' : 'sold bitcoin'}
        </Text>{' '}
        — you were{' '}
        <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.textPrimary}>
          {stage.fcRes.off.toFixed(0)} points off
        </Text>
        . {stage.fcRes.verdict}
      </Text>
    )}

    {/* ticker */}
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="clamp(26px, 5vw, 44px)" {...tabular} letterSpacing="-0.02em" lineHeight={1} color={stage.tickHurt ? SEMANTIC_COLORS.danger : stage.tickGold ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.success}>
      {stage.tickText}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10.5px" color={SEMANTIC_COLORS.textTertiary}>
      {stage.tickNText}
    </Text>
    <Box h="6px" bg={TINTS.boneBar} position="relative">
      <Box position="absolute" top={0} bottom={0} left={0} w={stage.pxWidth + '%'} bg={SEMANTIC_COLORS.success} />
    </Box>

    {stage.auditVisible && <AuditTable stage={stage} />}
    {stage.ghostsVisible && stage.ghosts && stage.ghostPlayerR && (
      <Ghosts rows={stage.ghosts} playerR={stage.ghostPlayerR} playerLabel={playerLabel} open={cfxOpen} onToggle={onToggleCfx} />
    )}
    {stage.howtoVisible && <HowTo />}

    <Box display="grid" gap={SPACING.sm}>
      {stage.nextVisible && (
        <Button {...btnSx} onClick={onNext}>
          Continue to Next Floor
        </Button>
      )}
      {stage.retryVisible && (
        <Button {...btnSx} onClick={onRetry}>
          Re-tune &amp; retry this floor
        </Button>
      )}
    </Box>
  </Box>
)

export default GauntletStage
