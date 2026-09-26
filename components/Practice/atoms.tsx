import React from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

export const Eyebrow: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.24em"
    textTransform="uppercase"
    color={color ?? SEMANTIC_COLORS.textTertiary}
  >
    {children}
  </Text>
)

export const Fact: React.FC<{ label: string; value: React.ReactNode; color?: string }> = ({ label, value, color }) => (
  <Box>
    <Eyebrow>{label}</Eyebrow>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="15px" color={color ?? SEMANTIC_COLORS.textPrimary} mt="2px">
      {value}
    </Text>
  </Box>
)

/** Hairline panel: 1px border, square corners. */
export const Panel: React.FC<{ children: React.ReactNode; accent?: string; [k: string]: unknown }> = ({
  children,
  accent,
  ...rest
}) => (
  <Box
    border="1px solid"
    borderColor={accent ?? SEMANTIC_COLORS.borderSubtle}
    borderRadius={0}
    bg={SEMANTIC_COLORS.bgSecondary}
    p={SPACING.base}
    {...rest}
  >
    {children}
  </Box>
)

export const ActionButton: React.FC<{
  children: React.ReactNode
  onClick: () => void
  active?: boolean
  disabled?: boolean
  ariaLabel?: string
}> = ({ children, onClick, active, disabled, ariaLabel }) => (
  <Button
    onClick={onClick}
    isDisabled={disabled}
    aria-label={ariaLabel}
    aria-pressed={active}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="12px"
    fontWeight={400}
    borderRadius={0}
    h="auto"
    py={SPACING.sm}
    px={SPACING.md}
    whiteSpace="normal"
    textAlign="left"
    justifyContent="flex-start"
    bg={active ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
    color={active ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textPrimary}
    border="1px solid"
    borderColor={active ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderStrong}
    transition={TRANSITIONS.colors}
    _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
    _focusVisible={FOCUS_STYLES.ring}
  >
    {children}
  </Button>
)
