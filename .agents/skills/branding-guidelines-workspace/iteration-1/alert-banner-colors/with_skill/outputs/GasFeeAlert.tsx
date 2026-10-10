import React, { memo, useCallback, useMemo } from 'react'
import {
  Box,
  HStack,
  VStack,
  Text,
  CloseButton,
  Icon,
} from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { WarningTwoIcon } from '@chakra-ui/icons'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import {
  TRANSITIONS,
  FOCUS_STYLES,
} from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

// ============================================
// TYPES
// ============================================

type GasFeeAlertSeverity = 'warning' | 'danger'

interface GasFeeAlertProps {
  /** Current severity level */
  severity: GasFeeAlertSeverity
  /** Current gas fee in the display unit (e.g. gwei, OSMO) */
  currentFee: string
  /** Human-readable description of the fee state */
  message?: string
  /** Whether the alert is visible */
  isVisible: boolean
  /** Callback when the user dismisses the alert */
  onDismiss: () => void
}

// ============================================
// SEVERITY THEME MAP
// ============================================

/**
 * Maps each severity level to its brand-correct color tokens.
 *
 * Warning uses SEMANTIC_COLORS.warning (#fbbf24) -- the mandated yellow
 * for "approaching limits / caution" states.
 *
 * Danger uses SEMANTIC_COLORS.danger (#ef4444) -- the mandated red
 * for "errors / critical issues / destructive actions."
 *
 * Every value here traces back to the Membrane semantic color system
 * so we never introduce one-off hex values.
 */
const SEVERITY_THEME: Record<
  GasFeeAlertSeverity,
  {
    accent: string
    bg: string
    border: string
    glow: string
    glowIdle: string
    glowPeak: string
    iconColor: string
    label: string
  }
> = {
  warning: {
    accent: SEMANTIC_COLORS.warning,               // #fbbf24
    bg: 'rgba(251, 191, 36, 0.08)',                // warning at 8% -- tint over dark glass
    border: 'rgba(251, 191, 36, 0.25)',            // warning at 25% -- visible but not harsh
    glow: '0 0 20px rgba(251, 191, 36, 0.3)',     // warm yellow glow
    glowIdle: '0 0 12px rgba(251, 191, 36, 0.2)', // breathing low point
    glowPeak: '0 0 24px rgba(251, 191, 36, 0.45)',// breathing high point
    iconColor: SEMANTIC_COLORS.warning,
    label: 'Elevated gas',
  },
  danger: {
    accent: SEMANTIC_COLORS.danger,                // #ef4444
    bg: 'rgba(239, 68, 68, 0.1)',                  // danger at 10% -- slightly more opaque for urgency
    border: 'rgba(239, 68, 68, 0.35)',             // danger at 35% -- stronger border for severity
    glow: '0 0 20px rgba(239, 68, 68, 0.4)',      // red glow, more intense than warning
    glowIdle: '0 0 12px rgba(239, 68, 68, 0.25)', // breathing low point
    glowPeak: '0 0 28px rgba(239, 68, 68, 0.55)', // breathing high point
    iconColor: SEMANTIC_COLORS.danger,
    label: 'Very high gas',
  },
}

// ============================================
// FRAMER MOTION VARIANTS
// ============================================

/**
 * Entrance: slides down from above and fades in using the brand easeOut curve.
 * Exit: reverses with the standard easeInOut curve.
 * The slight scale (0.98 -> 1) adds the "materialising" feel that matches
 * the app's modal and toast entrance patterns.
 */
const bannerVariants = {
  hidden: {
    opacity: 0,
    y: -24,
    scale: 0.98,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.35,
      ease: [0.16, 1, 0.3, 1], // brand easeOut
    },
  },
  exit: {
    opacity: 0,
    y: -16,
    scale: 0.98,
    transition: {
      duration: 0.2,
      ease: [0.4, 0, 0.2, 1], // brand easeInOut
    },
  },
}

// ============================================
// COMPONENT
// ============================================

/**
 * GasFeeAlert
 *
 * A top-of-page alert banner that warns users when network gas fees are
 * elevated (warning) or critically high (danger). Designed to sit at the
 * top of the page layout, above the main content area.
 *
 * Brand alignment:
 * - Semantic color system for warning (#fbbf24) and danger (#ef4444) states
 * - Glassmorphism background (dark glass + colored tint + backdrop blur)
 * - Signature neon glow that breathes via CSS animation
 * - Smooth entrance/exit via Framer Motion with brand easing curves
 * - Cyberpunk/HUD aesthetic: uppercase labels, monospace fee value, text glow
 * - Accessible: role="alert", aria-live, focus ring on dismiss button
 * - Performance: memo, useMemo, useCallback to prevent unnecessary re-renders
 */
export const GasFeeAlert: React.FC<GasFeeAlertProps> = memo(
  ({ severity, currentFee, message, isVisible, onDismiss }) => {
    const theme = useMemo(() => SEVERITY_THEME[severity], [severity])

    const defaultMessage = useMemo(() => {
      if (message) return message
      return severity === 'warning'
        ? 'Gas fees are higher than usual -- consider waiting for lower network activity.'
        : 'Gas fees are extremely high -- transactions will be expensive. Proceed with caution.'
    }, [severity, message])

    const handleDismiss = useCallback(() => {
      onDismiss()
    }, [onDismiss])

    const breathingAnimation = useMemo(
      () =>
        severity === 'danger'
          ? 'gasFeeAlertBreatheDanger 2.5s ease-in-out infinite'
          : 'gasFeeAlertBreatheWarning 3s ease-in-out infinite',
      [severity]
    )

    return (
      <AnimatePresence mode="wait">
        {isVisible && (
          <motion.div
            key={`gas-alert-${severity}`}
            variants={bannerVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            style={{ width: '100%' }}
          >
            <Box
              role="alert"
              aria-live="assertive"
              w="100%"
              bg={theme.bg}
              backdropFilter="blur(8px)"
              border="1px solid"
              borderColor={theme.border}
              borderRadius="24px"
              boxShadow={theme.glow}
              transition={TRANSITIONS.all}
              position="relative"
              overflow="hidden"
              sx={{
                '@keyframes gasFeeAlertBreatheWarning': {
                  '0%, 100%': { boxShadow: theme.glowIdle },
                  '50%': { boxShadow: theme.glowPeak },
                },
                '@keyframes gasFeeAlertBreatheDanger': {
                  '0%, 100%': { boxShadow: theme.glowIdle },
                  '50%': { boxShadow: theme.glowPeak },
                },
                animation: breathingAnimation,
              }}
            >
              {/* Left accent bar -- vertical stripe in the state color with its own glow */}
              <Box
                position="absolute"
                left={0}
                top={0}
                bottom={0}
                w="4px"
                bg={theme.accent}
                borderLeftRadius="24px"
                boxShadow={`0 0 8px ${theme.accent}`}
              />

              <HStack
                spacing={SPACING_PATTERNS.stackSpacing}
                align="center"
                px={SPACING.lg}
                py={SPACING.md}
              >
                {/* Icon with drop-shadow glow */}
                <Box
                  flexShrink={0}
                  filter={`drop-shadow(0 0 6px ${theme.accent})`}
                >
                  <Icon
                    as={WarningTwoIcon}
                    color={theme.iconColor}
                    boxSize="20px"
                  />
                </Box>

                {/* Content area */}
                <VStack
                  spacing={SPACING.xs}
                  align="flex-start"
                  flex={1}
                  minW={0}
                >
                  <HStack spacing={SPACING.sm} align="baseline">
                    {/* Severity label -- uppercase HUD style per typography spec */}
                    <Text
                      fontSize={TYPOGRAPHY.label}
                      fontWeight={TYPOGRAPHY.semibold}
                      textTransform="uppercase"
                      letterSpacing="0.1em"
                      color={theme.accent}
                      whiteSpace="nowrap"
                    >
                      {theme.label}
                    </Text>

                    {/* Fee value -- monospace for HUD/data-display aesthetic */}
                    <Text
                      fontSize={TYPOGRAPHY.small}
                      fontWeight={TYPOGRAPHY.bold}
                      fontFamily="'Spline Sans', monospace"
                      color={SEMANTIC_COLORS.textPrimary}
                      textShadow={`0 0 5px ${theme.accent}`}
                      whiteSpace="nowrap"
                    >
                      {currentFee}
                    </Text>
                  </HStack>

                  {/* Description text */}
                  <Text
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textSecondary}
                    lineHeight="1.4"
                    noOfLines={2}
                  >
                    {defaultMessage}
                  </Text>
                </VStack>

                {/* Dismiss button with accessible focus ring */}
                <CloseButton
                  size="sm"
                  color={SEMANTIC_COLORS.textTertiary}
                  transition={TRANSITIONS.allQuick}
                  _hover={{
                    color: SEMANTIC_COLORS.textPrimary,
                    bg: 'whiteAlpha.100',
                  }}
                  _focus={FOCUS_STYLES.ring}
                  onClick={handleDismiss}
                  aria-label="Dismiss gas fee alert"
                  flexShrink={0}
                />
              </HStack>
            </Box>
          </motion.div>
        )}
      </AnimatePresence>
    )
  }
)

GasFeeAlert.displayName = 'GasFeeAlert'

export default GasFeeAlert