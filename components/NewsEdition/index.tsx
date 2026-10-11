// THE NEWS EDITION — the newspaper shell for read-only surfaces (owner rulings T20 / Q11).
//
// One context and four pieces:
//   NewsEditionProvider / useNewsEdition  lets a shared component (VerdictHero, the
//                       GuaranteeBlock, CrossingChart…) restyle itself in place when it
//                       is mounted inside the edition, and render exactly as before
//                       anywhere else. The default is false.
//   NewsMasthead        heavy rule, the left rail, the Redaction wordmark + tagline +
//                       local dateline, and the "In this edition" index.
//   Kicker              the numbered section head ("03 · The guarantee").
//   RailCard            a severity-bordered alert card (danger / info).
//   Figures             a Redaction headline with its figures marked: bold, unbroken,
//                       optionally chipped, and still Redaction (NEWS_FIGURE.display).
//
// The grammar (Grammar canvas, T31): solid rules only, square 1px cards. A dashed edge
// means "this leads to a signature", and this edition signs nothing.

import React, { createContext, useContext, useEffect, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { fmtLocalDateline, useLocalZone } from '@/components/Simulator/localClock'
import { useThemeMode } from '@/hooks/useThemeMode'
import { LANDING_TAGLINE } from '@/lib/position-sim/guarantee'

import {
  EDITION_LABEL,
  NEWS,
  NEWS_FIGURE,
  NEWS_FONT,
  NEWS_SECTIONS,
  WORDMARK_FIT,
  splitFigures,
} from './tokens'

export * from './tokens'

const NewsEditionContext = createContext(false)

export const NewsEditionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <NewsEditionContext.Provider value={true}>{children}</NewsEditionContext.Provider>
)

/** True only inside a mounted news edition. */
export const useNewsEdition = (): boolean => useContext(NewsEditionContext)

/** Small caps-style mono label: the kicker, the rail labels, table heads. */
export const LABEL = {
  fontFamily: NEWS_FONT.mono,
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
}

export const Kicker: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = NEWS.accent,
}) => (
  <Text {...LABEL} color={color} lineHeight={1.5} overflowWrap="anywhere">
    {children}
  </Text>
)

/**
 * A Redaction headline with its figures marked. The figures are display figures
 * (NEWS_FIGURE.display): Redaction 700 at the line's own size, never broken across a
 * line. `chip` sets each figure on the raised paper, as the canvas does inside the
 * verdict headline. Owner ruling 2026-10-11: big numbers are Redaction, not Mono.
 */
export const Figures: React.FC<{ text: string; chip?: boolean }> = ({ text, chip = false }) => (
  <>
    {splitFigures(text).map((run, i) =>
      run.figure ? (
        <Text
          as="span"
          key={i}
          {...NEWS_FIGURE.display}
          bg={chip ? NEWS.raised : undefined}
          px={chip ? '6px' : undefined}
          whiteSpace="nowrap"
        >
          {run.text}
        </Text>
      ) : (
        <React.Fragment key={i}>{run.text}</React.Fragment>
      ),
    )}
  </>
)

/** Severity-bordered alert card (T20 layout: a pale card with a coloured left rule). */
export const RailCard: React.FC<{
  tone: string
  label: React.ReactNode
  children?: React.ReactNode
  testId?: string
}> = ({ tone, label, children, testId }) => (
  <Box
    data-testid={testId}
    borderLeft="3px solid"
    borderColor={tone}
    bg={NEWS.raised}
    px="12px"
    py="9px"
    display="grid"
    gap="4px"
    minW={0}
  >
    <Text
      fontFamily={NEWS_FONT.mono}
      fontSize="12px"
      fontWeight={700}
      letterSpacing="0.08em"
      textTransform="uppercase"
      color={tone}
      lineHeight={1.4}
    >
      {label}
    </Text>
    {children}
  </Box>
)

/** The dateline is the reader's own day, so it renders after mount (SSR has no zone). */
const useNow = (): number | null => {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => setNow(Date.now()), [])
  return now
}

export const NewsMasthead: React.FC<{ rail: React.ReactNode }> = ({ rail }) => {
  const zone = useLocalZone()
  const now = useNow()
  const { mode } = useThemeMode()

  return (
    <Box as="header" data-testid="news-masthead">
      <Box h="3px" bg={NEWS.ink} />
      <Box display="flex" flexWrap="wrap" alignItems="flex-start" gap="24px" pt="22px" pb="20px">
        {/* THE RAIL. Stacks under the wordmark on a phone. */}
        <Box
          flex="1 1 270px"
          minW={0}
          display="flex"
          flexDirection="column"
          gap="8px"
          data-testid="news-rail"
        >
          {rail}
        </Box>

        {/* THE WORDMARK. A div, not an h1: the verdict stays the page's one h1. The
            column is a size container, so the wordmark is sized by the column it sits
            in rather than the viewport: the column jumps when the masthead wraps
            (380px at a 1016px viewport, 496px at 1280px), and a vw size cannot follow
            that. See WORDMARK_FIT for the measured width. */}
        <Box
          flex="2 1 380px"
          minW={0}
          textAlign="center"
          order={{ base: -1, md: 0 }}
          sx={{ containerType: 'inline-size' }}
        >
          <Text
            as="div"
            fontFamily={NEWS_FONT.display}
            fontWeight={700}
            lineHeight={0.95}
            letterSpacing="-0.01em"
            whiteSpace="nowrap"
            color={NEWS.ink}
            sx={{
              fontSize: WORDMARK_FIT.fallback,
              '@supports (width: 1cqi)': { fontSize: WORDMARK_FIT.size },
            }}
          >
            Membrane
          </Text>
          <Text
            data-testid="news-tagline"
            mt="12px"
            fontFamily={NEWS_FONT.display}
            fontSize={{ base: '19px', md: '22px' }}
            lineHeight={1.3}
            color={NEWS.ink2}
          >
            {LANDING_TAGLINE}
          </Text>
          <Text
            data-testid="news-dateline"
            mt="8px"
            {...LABEL}
            color={NEWS.muted}
            minH="1.5em"
            suppressHydrationWarning
          >
            {now !== null ? `${fmtLocalDateline(now, zone)} · ${EDITION_LABEL[mode]}` : ' '}
          </Text>
        </Box>

        {/* THE INDEX */}
        <Box
          as="nav"
          aria-label="In this edition"
          flex="1 1 270px"
          minW={0}
          textAlign={{ base: 'left', md: 'right' }}
        >
          <Text
            as="div"
            display="inline-block"
            fontFamily={NEWS_FONT.display}
            fontWeight={700}
            fontSize="18px"
            letterSpacing="0.06em"
            textTransform="uppercase"
            color={NEWS.accent}
            borderBottom="1px solid"
            borderColor={NEWS.accent}
            pb="2px"
          >
            In this edition
          </Text>
          <Box
            as="ol"
            listStyleType="none"
            m={0}
            mt="8px"
            p={0}
            display="flex"
            flexDirection="column"
            gap="4px"
            fontFamily={NEWS_FONT.mono}
            fontSize="13px"
            color={NEWS.ink2}
          >
            {NEWS_SECTIONS.map((s) => (
              <Box as="li" key={s.id}>
                <Box
                  as="a"
                  href={`#${s.id}`}
                  textDecoration="none"
                  _hover={{ color: NEWS.accent }}
                  display="inline-block"
                  py="2px"
                >
                  {s.number} {s.title}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
      <Box h="1px" bg={NEWS.ink} />
    </Box>
  )
}
