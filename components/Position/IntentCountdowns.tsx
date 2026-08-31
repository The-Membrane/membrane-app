import React, { useState } from 'react'
import NextLink from 'next/link'
import { Box, Grid, HStack, Select, Text, VStack } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import { Warm, WarmGate, VetBadge, SectionHead } from './primitives'
import { ExecButton } from './ExecContext'
import { INTENTS, SPREAD_AXIS, SPREAD_SPIKED, SPREAD_TODAY } from './fixtures'
import { computeSpread, withAlpha } from './utils'
import { HpBar, Intent, MiniRow, RngBar } from './types'

const BAND_COLOR = {
  days: SEMANTIC_COLORS.textPrimary,
  v: SEMANTIC_COLORS.info,
  vgold: SEMANTIC_COLORS.warning,
} as const

const MINI_COLOR = {
  phos: SEMANTIC_COLORS.success,
  gold: SEMANTIC_COLORS.warning,
  blood: SEMANTIC_COLORS.danger,
} as const

const HpTrack: React.FC<{ bar: HpBar }> = ({ bar }) => (
  <Box position="relative" h="9px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} m="14px 0 6px">
    <Box h="100%" w={`${bar.fill}%`} bg={SEMANTIC_COLORS.danger} />
    <Box position="absolute" top="-3px" bottom="-3px" left={`${bar.mark}%`} w="1px" bg={SEMANTIC_COLORS.borderStrong} />
  </Box>
)

const RngTrack: React.FC<{ bar: RngBar }> = ({ bar }) => {
  const edgeColor = bar.gold ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.info
  const bandColor = withAlpha(bar.gold ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.info, 0.28)
  return (
    <Box position="relative" h="11px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} m="14px 0 6px">
      <Box position="absolute" top={0} bottom={0} left={`${bar.bandLeft}%`} w={`${bar.bandWidth}%`} bg={bandColor} />
      {bar.edges.map((e, i) => (
        <Box key={i} position="absolute" top="-3px" bottom="-3px" left={`${e}%`} w="1px" bg={edgeColor} />
      ))}
      {bar.pt !== undefined && <Box position="absolute" top="-4px" bottom="-4px" left={`${bar.pt}%`} w="2px" bg={SEMANTIC_COLORS.textPrimary} />}
      {bar.goal !== undefined && <Box position="absolute" top="-4px" bottom="-4px" left={`${bar.goal}%`} w="1px" bg={SEMANTIC_COLORS.borderStrong} />}
    </Box>
  )
}

const MiniRowView: React.FC<{ row: MiniRow }> = ({ row }) => (
  <HStack justify="space-between" fontSize="10.5px" color={SEMANTIC_COLORS.textSecondary}>
    <Text as="span">{row.label}</Text>
    <Box as="span" fontWeight={400} color={row.color ? MINI_COLOR[row.color] : SEMANTIC_COLORS.textPrimary}>
      {row.value}
      {row.claim && (
        <ExecButton ml={SPACING.sm} payload={row.claim}>
          Claim
        </ExecButton>
      )}
    </Box>
  </HStack>
)

const Wico: React.FC<{ title: string; body: string }> = ({ title, body }) => {
  const [open, setOpen] = useState(false)
  return (
    <Box
      as="span"
      tabIndex={0}
      role="note"
      position="relative"
      display="inline-block"
      w="15px"
      h="15px"
      lineHeight="13px"
      textAlign="center"
      ml="7px"
      verticalAlign="2px"
      fontSize="10px"
      color={SEMANTIC_COLORS.warning}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.warning}
      cursor="help"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      !
      {open && (
        <Box position="absolute" left="10px" right="-160px" top="24px" zIndex={9} bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={SEMANTIC_COLORS.warning} p="12px 14px" w="240px" textAlign="left">
          <Text as="span" display="block" fontSize="10px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.warning} mb="6px">
            {title}
          </Text>
          <Text as="span" display="block" fontSize="11px" lineHeight={1.65} color={SEMANTIC_COLORS.textSecondary}>
            {body}
          </Text>
        </Box>
      )}
    </Box>
  )
}

const IntentCard: React.FC<{ intent: Intent }> = ({ intent }) => (
  <Card borderColor={intent.active ? SEMANTIC_COLORS.borderStrong : undefined}>
    <HStack justify="space-between" align="baseline" spacing={SPACING.sm}>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="16px" color={SEMANTIC_COLORS.textPrimary}>
        {intent.name}
        {intent.wico && <Wico title={intent.wico.title} body={intent.wico.body} />}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={intent.active ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}>
        {intent.tag}
      </Text>
    </HStack>

    <Box fontFamily={TYPOGRAPHY.fontMono} fontSize="26px" m="14px 0 2px" color={BAND_COLOR[intent.leadBand]}>
      {intent.lead}
      {intent.leadUnit && (
        <Box as="span" fontSize="13px" color={SEMANTIC_COLORS.textSecondary}>
          {' '}
          {intent.leadUnit}
        </Box>
      )}
      <VetBadge>{intent.badge}</VetBadge>
    </Box>

    <Warm fontFamily={TYPOGRAPHY.fontMono} fontSize="10.5px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.5}>
      {intent.desc}
    </Warm>

    {intent.bar.type === 'hp' ? <HpTrack bar={intent.bar} /> : <RngTrack bar={intent.bar} />}
    <HStack justify="space-between" fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
      <Text as="span">{intent.notes[0]}</Text>
      <Text as="span">{intent.notes[1]}</Text>
    </HStack>

    <VStack align="stretch" spacing="5px" mt={SPACING.md} pt="11px" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      {intent.mini.map((row, i) => (
        <MiniRowView key={i} row={row} />
      ))}
    </VStack>
  </Card>
)

/** Section 2 — per-intent countdowns, the spread dial, and the inversion nudge. */
export const IntentCountdowns: React.FC = () => {
  const [selected, setSelected] = useState(0)
  const [spiked, setSpiked] = useState(false)
  const { chainName } = useChainRoute()

  const scenario = spiked ? SPREAD_SPIKED : SPREAD_TODAY
  const spread = computeSpread(scenario.apr, scenario.borrow, SPREAD_AXIS)
  const intent = INTENTS[selected]
  const switchTarget = INTENTS[selected]

  return (
    <>
      <SectionHead
        index="02 /"
        title="What the yield is doing —"
        note="The menu previews the intents you did not pick. Nothing switches unless you switch it."
      >
        <Select
          value={selected}
          onChange={(e) => setSelected(Number(e.target.value))}
          aria-label="View another intent"
          w="auto"
          borderRadius={0}
          bg={SEMANTIC_COLORS.bgTertiary}
          color={SEMANTIC_COLORS.textPrimary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="13px"
          h="auto"
          py="4px"
          _focus={FOCUS_STYLES.ring}
        >
          <option value={0}>Repay · running</option>
          <option value={1}>Compound · preview</option>
          <option value={2}>Distribute · preview</option>
        </Select>
        <Box
          as="button"
          type="button"
          ml="auto"
          bg="transparent"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          color={SEMANTIC_COLORS.textSecondary}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="9.5px"
          letterSpacing="0.18em"
          textTransform="uppercase"
          p="7px 11px"
          cursor="pointer"
          transition={TRANSITIONS.colors}
          _hover={{ borderColor: SEMANTIC_COLORS.warning, color: SEMANTIC_COLORS.warning }}
          _focus={FOCUS_STYLES.ring}
          onClick={() => setSpiked((s) => !s)}
        >
          {spiked ? 'Back to today' : 'Preview a rate spike'}
        </Box>
      </SectionHead>

      <Box id="intents">
        <IntentCard intent={intent} />
      </Box>

      {/* Switch-intent rail: the preview menu can DO the thing it previews. */}
      {selected !== 0 && (
        <HStack spacing={SPACING.sm} flexWrap="wrap" mt="10px">
          <ExecButton
            variant="go"
            payload={{
              title: `Switch intent to ${switchTarget.name}`,
              rows: [
                ['Running now', 'Repay'],
                ['Switch to', switchTarget.name],
                ['LTV path', `falls → ${selected === 1 ? 'rises' : 'flat'}`],
                ['Takes effect', 'next harvest'],
              ],
              cta: 'Sign & switch',
              done: 'Intent switched',
            }}
          >
            Switch to {switchTarget.name}
          </ExecButton>
        </HStack>
      )}

      {/* Spread dial: signed axis, zero pinned; an inversion is a direction change you see. */}
      <Grid
        gridTemplateColumns="auto 1fr auto"
        gap={SPACING.md}
        alignItems="center"
        mt={SPACING.md}
        p="12px 14px"
        bg={SEMANTIC_COLORS.bgTertiary}
        border="1px solid"
        borderColor={spread.inv ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.borderSubtle}
      >
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
          Spread
        </Text>
        <Box position="relative" h="3px" bg={SEMANTIC_COLORS.bgPrimary}>
          <Box position="absolute" top={0} bottom={0} left={`${spread.barLeft}%`} w={`${spread.barWidth}%`} bg={spread.inv ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.info} />
          <Box position="absolute" top="-4px" bottom="-4px" left={`${spread.zeroLeft}%`} w="1px" bg={SEMANTIC_COLORS.borderStrong} />
        </Box>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="15px" color={spread.inv ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.info}>
          {spread.valText}
        </Text>
      </Grid>
      <Warm fontFamily={TYPOGRAPHY.fontMono} fontSize="10.5px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.sm} lineHeight={1.7}>
        {spread.note}
      </Warm>

      {/* Nudge: appears only when the spread inverts. */}
      {spread.inv && (
        <Grid gridTemplateColumns="34px 1fr" gap={SPACING.base} alignItems="start" mt={SPACING.md} p="15px 16px" bg={SEMANTIC_COLORS.bgTertiary} border="1px solid" borderColor={SEMANTIC_COLORS.warning}>
          <Box>
            <svg width="34" height="34" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
              <g fill={SEMANTIC_COLORS.warning}>
                <rect x="5" y="2" width="6" height="1" />
                <rect x="4" y="3" width="8" height="1" />
                <rect x="3" y="4" width="10" height="2" />
                <rect x="2" y="6" width="12" height="3" />
                <rect x="3" y="9" width="10" height="2" />
                <rect x="4" y="11" width="8" height="1" />
                <rect x="5" y="12" width="6" height="1" />
              </g>
              <g fill={SEMANTIC_COLORS.bgPrimary}>
                <rect x="5" y="6" width="2" height="2" />
                <rect x="9" y="6" width="2" height="2" />
                <rect x="6" y="10" width="4" height="1" />
              </g>
            </svg>
          </Box>
          <Box>
            <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="15px" color={SEMANTIC_COLORS.warning}>
              The spread just inverted.
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary} mt="5px" lineHeight={1.65} maxW="78ch">
              {spread.nudgeBody}
            </Text>
            <HStack spacing={SPACING.sm} mt="11px" flexWrap="wrap">
              <NudgeBtn>Switch to Repay</NudgeBtn>
              <NudgeBtn>Leave it, I am watching</NudgeBtn>
            </HStack>
          </Box>
        </Grid>
      )}

      {/* Builder cross-link: drill this exact scenario in the Builder. */}
      <WarmGate>
        <NextLink href={`/${chainName}/builder`} passHref legacyBehavior>
          <Box
            as="a"
            display="inline-block"
            mt={SPACING.md}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            letterSpacing="0.16em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textSecondary}
            borderBottom="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            transition={TRANSITIONS.colors}
            _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
          >
            Drill this scenario in Builder →
          </Box>
        </NextLink>
      </WarmGate>
    </>
  )
}

const NudgeBtn: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box
    as="button"
    type="button"
    bg="transparent"
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    color={SEMANTIC_COLORS.textSecondary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    p="9px 13px"
    cursor="pointer"
    transition={TRANSITIONS.colors}
    _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
    _focus={FOCUS_STYLES.ring}
  >
    {children}
  </Box>
)
