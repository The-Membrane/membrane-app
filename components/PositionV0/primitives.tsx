// Newspaper furniture for the /position page (DESIGN_RULES §1, §6): rules not boxes,
// one caps tracking (.12em), at most five type steps — Mono 11 / 13, Redaction 22 / 40 /
// hero. Every colour comes from the news-edition token layer (styles/news-edition.css).

import React from 'react'
import { Box, Text, type BoxProps, type TextProps } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { CAPS, TYPE } from './typeScale'


/** Kicker / small label: mono 11, caps. Section heads take the accent; labels stay muted. */
export const Kicker: React.FC<TextProps & { tone?: 'accent' | 'muted' }> = ({ tone = 'accent', children, ...rest }) => (
  <Text
    fontFamily={NEWS_FONT.mono}
    fontSize={TYPE.label}
    fontWeight={700}
    {...CAPS}
    color={tone === 'accent' ? NEWS.accent : NEWS.muted}
    lineHeight={1.5}
    {...rest}
  >
    {children}
  </Text>
)

/** Section headline: Redaction 700 at 22. */
export const Headline: React.FC<TextProps> = ({ children, ...rest }) => (
  <Text as="h2" fontFamily={NEWS_FONT.display} fontWeight={700} fontSize={TYPE.head} lineHeight={1.2} color={NEWS.ink} {...rest}>
    {children}
  </Text>
)

/** Body / data line: mono 13. */
export const Mono: React.FC<TextProps> = ({ children, ...rest }) => (
  <Text fontFamily={NEWS_FONT.mono} fontSize={TYPE.body} lineHeight={1.5} color={NEWS.ink} sx={{ fontVariantNumeric: 'tabular-nums' }} {...rest}>
    {children}
  </Text>
)

/** Small mono line: credits, captions, footnotes. */
export const Small: React.FC<TextProps> = ({ children, ...rest }) => (
  <Text fontFamily={NEWS_FONT.mono} fontSize={TYPE.label} lineHeight={1.5} color={NEWS.muted} sx={{ fontVariantNumeric: 'tabular-nums' }} {...rest}>
    {children}
  </Text>
)

/** A hairline rule. `strong` is the heavier seam between sections. */
export const Rule: React.FC<BoxProps & { strong?: boolean }> = ({ strong = false, ...rest }) => (
  <Box as="hr" border={0} borderTop={`1px solid ${strong ? NEWS.ruleStrong : NEWS.rule}`} m={0} {...rest} />
)

/** Provenance: a small right-aligned credit line, not a badge (§6). */
export const Credit: React.FC<TextProps> = ({ children, ...rest }) => (
  <Small textAlign="right" overflowWrap="anywhere" {...rest}>
    {children}
  </Small>
)

/** A page section with its anchor hook and the standard seam above it. */
export const Section: React.FC<BoxProps & { id: string }> = ({ id, children, ...rest }) => (
  <Box as="section" data-news-section={id} id={id} pt={SPACING.md} display="grid" gap={SPACING.sm} minW={0} {...rest}>
    {children}
  </Box>
)

/** A dagger set small and raised beside a big figure, so it marks without shouting. */
export const Dagger: React.FC = () => (
  <Text as="span" fontSize="0.45em" verticalAlign="super" lineHeight={0} ml="0.05em">
    †
  </Text>
)
