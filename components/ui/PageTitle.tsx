import React from 'react'
import { Text, TextProps, VStack } from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

export interface PageTitleProps extends Omit<TextProps, 'title'> {
  /**
   * The title text to display
   */
  title: string

  /**
   * Optional subtitle text
   */
  subtitle?: string

  /**
   * Optional subtitle color
   * @default SEMANTIC_COLORS.textSecondary
   */
  subtitleColor?: string
}

/**
 * PageTitle Component
 *
 * The ONE canonical page-title treatment: Redaction display serif, normal case,
 * `SEMANTIC_COLORS.textPrimary`, h1 size. Every page H1 in the app uses this —
 * no variants, no accent color, no uppercase, no gradient.
 *
 * There is deliberately no `variant` / `gradient` / `uppercase` escape hatch: a
 * mono, uppercased or gradient page title is a violation of the type rule
 * (CLAUDE.md — page titles are serif, section titles are serif, body/data/labels
 * are JetBrains Mono), so the component cannot express one. The arcade/minigame
 * surfaces (tournament, maze-runners) have their own bespoke "Press Start 2P"
 * headers and do not route through this component.
 *
 * @example
 * ```tsx
 * // Canonical page title
 * <PageTitle title="Portfolio" />
 *
 * // With a subtitle
 * <PageTitle
 *   title="Boosts"
 *   subtitle="Manage your deposit boost sources"
 * />
 *
 * // With layout overrides
 * <PageTitle
 *   title="Custom Title"
 *   mb={12}
 *   textAlign="center"
 * />
 * ```
 */
export const PageTitle: React.FC<PageTitleProps> = ({
  title,
  subtitle,
  subtitleColor = SEMANTIC_COLORS.textSecondary,
  ...props
}) => {
  const baseStyles: TextProps = {
    as: 'h1',
    // Redaction display serif. A bare <Text> inherits the theme `body` token
    // (JetBrains Mono), so the display face has to be set explicitly here.
    fontFamily: TYPOGRAPHY.fontDisplay,
    fontSize: TYPOGRAPHY.h1,
    fontWeight: TYPOGRAPHY.bold,
    color: SEMANTIC_COLORS.textPrimary,
    mb: subtitle ? 2 : 6,
  }

  const titleStyles = { ...baseStyles, ...props }

  if (subtitle) {
    return (
      <VStack align="flex-start" spacing={1} mb={6}>
        <Text {...titleStyles}>{title}</Text>
        <Text
          fontSize="sm"
          color={subtitleColor}
          // Subtitles are body copy — JetBrains Mono.
          fontFamily={TYPOGRAPHY.fontMono}
        >
          {subtitle}
        </Text>
      </VStack>
    )
  }

  return <Text {...titleStyles}>{title}</Text>
}

export default PageTitle
