import React, { memo, useCallback } from 'react'
import { Box, HStack, Text, IconButton, Icon } from '@chakra-ui/react'
import { CloseIcon } from '@chakra-ui/icons'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Flame } from 'lucide-react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

const MotionBox = motion(Box)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GasFeeAlertSeverity = 'warning' | 'danger'

export interface GasFeeAlertProps {
  /** Current severity level */
  severity: GasFeeAlertSeverity
  /** Whether the banner is visible */
  isVisible: boolean
  /** Callback when the user dismisses the banner */
  onDismiss: () => void
  /** Optional current gas multiplier to display (e.g. "2.4x") */
  gasMultiplier?: string
  /** Optional custom message override */
  message?: string
}

// ---------------------------------------------------------------------------
// Color Palette (derived from SEMANTIC_COLORS)
//
// Warning state  -- uses SEMANTIC_COLORS.warning (#fbbf24 / yellow)
//   Background:   rgba(251, 191, 36, 0.08)   -- very faint yellow tint
//   Border:       rgba(251, 191, 36, 0.30)   -- visible yellow border
//   Icon / badge: #fbbf24                     -- full warning yellow
//   Text heading: #fde68a                     -- lighter yellow for readability
//
// Danger state   -- uses SEMANTIC_COLORS.danger (#ef4444 / red)
//   Background:   rgba(239, 68, 68, 0.10)    -- very faint red tint
//   Border:       rgba(239, 68, 68, 0.40)    -- visible red border
//   Icon / badge: #ef4444                     -- full danger red
//   Text heading: #fca5a5                     -- lighter red for readability
// ---------------------------------------------------------------------------

const ALERT_STYLES: Record<
  GasFeeAlertSeverity,
  {
    bg: string
    borderColor: string
    iconColor: string
    headingColor: string
    badgeBg: string
    badgeColor: string
    glowShadow: string
  }
> = {
  warning: {
    bg: 'rgba(251, 191, 36, 0.08)',
    borderColor: 'rgba(251, 191, 36, 0.30)',
    iconColor: SEMANTIC_COLORS.warning, // #fbbf24
    headingColor: '#fde68a',
    badgeBg: 'rgba(251, 191, 36, 0.15)',
    badgeColor: SEMANTIC_COLORS.warning, // #fbbf24
    glowShadow: '0 0 16px rgba(251, 191, 36, 0.12)',
  },
  danger: {
    bg: 'rgba(239, 68, 68, 0.10)',
    borderColor: 'rgba(239, 68, 68, 0.40)',
    iconColor: SEMANTIC_COLORS.danger, // #ef4444
    headingColor: '#fca5a5',
    badgeBg: 'rgba(239, 68, 68, 0.18)',
    badgeColor: SEMANTIC_COLORS.danger, // #ef4444
    glowShadow: '0 0 16px rgba(239, 68, 68, 0.15)',
  },
}

const DEFAULT_MESSAGES: Record<GasFeeAlertSeverity, string> = {
  warning: 'Gas fees are elevated. Consider waiting for lower network congestion.',
  danger: 'Gas fees are very high right now. Transactions may be expensive.',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * GasFeeAlert
 *
 * A dismissible alert banner that communicates network gas-fee conditions.
 * Supports two severity levels:
 *
 *  - **warning** (yellow) -- fees are elevated but still reasonable
 *  - **danger**  (red)    -- fees are critically high
 *
 * Colors are derived from the project semantic color system
 * (SEMANTIC_COLORS.warning / SEMANTIC_COLORS.danger) so they stay
 * consistent with the rest of the Membrane design language.
 *
 * @example
 * ```tsx
 * <GasFeeAlert
 *   severity="warning"
 *   isVisible={showBanner}
 *   onDismiss={() => setShowBanner(false)}
 *   gasMultiplier="2.4x"
 * />
 * ```
 */
export const GasFeeAlert: React.FC<GasFeeAlertProps> = memo(
  ({ severity, isVisible, onDismiss, gasMultiplier, message }) => {
    const styles = ALERT_STYLES[severity]
    const displayMessage = message ?? DEFAULT_MESSAGES[severity]
    const AlertIconComponent = severity === 'danger' ? Flame : AlertTriangle

    const handleDismiss = useCallback(() => {
      onDismiss()
    }, [onDismiss])

    return (
      <AnimatePresence>
        {isVisible && (
          <MotionBox
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            overflow="hidden"
          >
            <Box
              bg={styles.bg}
              border="1px solid"
              borderColor={styles.borderColor}
              borderRadius="md"
              p={SPACING.md}
              boxShadow={styles.glowShadow}
              transition={TRANSITIONS.all}
              role="alert"
              aria-live="polite"
            >
              <HStack
                spacing={SPACING_PATTERNS.stackSpacing}
                align="flex-start"
              >
                {/* Icon */}
                <Icon
                  as={AlertIconComponent}
                  w={5}
                  h={5}
                  color={styles.iconColor}
                  mt={0.5}
                  flexShrink={0}
                />

                {/* Message body */}
                <Box flex={1}>
                  <HStack spacing={SPACING.sm} mb={SPACING.xs} align="center">
                    <Text
                      fontSize={TYPOGRAPHY.small}
                      fontWeight={TYPOGRAPHY.semibold}
                      color={styles.headingColor}
                    >
                      {severity === 'danger'
                        ? 'High Gas Fees'
                        : 'Elevated Gas Fees'}
                    </Text>

                    {gasMultiplier && (
                      <Box
                        bg={styles.badgeBg}
                        px={SPACING.sm}
                        py={0.5}
                        borderRadius="full"
                      >
                        <Text
                          fontSize={TYPOGRAPHY.xs}
                          fontWeight={TYPOGRAPHY.medium}
                          color={styles.badgeColor}
                        >
                          {gasMultiplier} avg
                        </Text>
                      </Box>
                    )}
                  </HStack>

                  <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    {displayMessage}
                  </Text>
                </Box>

                {/* Dismiss button */}
                <IconButton
                  aria-label="Dismiss gas fee alert"
                  icon={<CloseIcon boxSize={2.5} />}
                  size="xs"
                  variant="ghost"
                  color={SEMANTIC_COLORS.textTertiary}
                  _hover={{
                    color: SEMANTIC_COLORS.textPrimary,
                    bg: 'transparent',
                  }}
                  onClick={handleDismiss}
                  minW="auto"
                  h="auto"
                  p={SPACING.xs}
                />
              </HStack>
            </Box>
          </MotionBox>
        )}
      </AnimatePresence>
    )
  },
)

GasFeeAlert.displayName = 'GasFeeAlert'

export default GasFeeAlert