import React, { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { ExecConfig } from './types'

/**
 * The one confirmation an irreversible action gets (VETERAN_UX_RULESET V6):
 * numbers, not prose; then pending; then settled. Mock chain, real
 * choreography. Ported from `window.__exec` in public/proto/carry.html.
 */
export interface ExecSheetProps {
  config: ExecConfig | null
  onClose: () => void
}

type Phase = 'confirm' | 'signing' | 'pending' | 'done'

export const ExecSheet: React.FC<ExecSheetProps> = ({ config, onClose }) => {
  const [phase, setPhase] = useState<Phase>('confirm')
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  // Reset to the confirm phase whenever a new config opens.
  useEffect(() => {
    if (config) setPhase('confirm')
    return () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
    }
  }, [config])

  if (!config) return null

  const runSign = () => {
    setPhase('signing')
    timers.current.push(
      setTimeout(() => {
        setPhase('pending')
        timers.current.push(setTimeout(() => setPhase('done'), 1100))
      }, 800)
    )
  }

  return (
    <Flex
      position="fixed"
      inset={0}
      zIndex={60}
      align="center"
      justify="center"
      bg="rgba(7,7,8,0.78)"
      p={SPACING.base}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <Box
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        borderRadius={0}
        p={SPACING.lg}
        w="min(430px, 92vw)"
      >
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h3}
          color={SEMANTIC_COLORS.textPrimary}
          mb={SPACING.md}
        >
          {config.title}
        </Text>

        <Box>
          {config.rows.map((r, i) => (
            <HStack
              key={i}
              justify="space-between"
              spacing={SPACING.base}
              py={SPACING.xs}
              borderBottom={i === config.rows.length - 1 ? 'none' : '1px solid'}
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                {r.label}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                fontWeight={TYPOGRAPHY.normal}
                color={SEMANTIC_COLORS.textPrimary}
                textAlign="right"
              >
                {r.value}
              </Text>
            </HStack>
          ))}
        </Box>

        {config.note && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight={1.6}
            mt={SPACING.md}
          >
            {config.note}
          </Text>
        )}

        {phase === 'confirm' && (
          <HStack spacing={SPACING.sm} mt={SPACING.base}>
            <Button
              flex={1}
              borderRadius={0}
              bg={SEMANTIC_COLORS.success}
              color={SEMANTIC_COLORS.bgPrimary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.success}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.14em"
              py={SPACING.md}
              _hover={{ bg: SEMANTIC_COLORS.success }}
              _focus={FOCUS_STYLES.ring}
              transition={TRANSITIONS.colors}
              onClick={runSign}
            >
              {config.cta ?? 'Confirm'}
            </Button>
            <Button
              borderRadius={0}
              bg="transparent"
              color={SEMANTIC_COLORS.textSecondary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.14em"
              py={SPACING.md}
              px={SPACING.base}
              _hover={{ borderColor: SEMANTIC_COLORS.textSecondary }}
              _focus={FOCUS_STYLES.ring}
              transition={TRANSITIONS.colors}
              onClick={onClose}
            >
              Cancel
            </Button>
          </HStack>
        )}

        {(phase === 'signing' || phase === 'pending') && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.warning}
            letterSpacing="0.08em"
            mt={SPACING.base}
          >
            {phase === 'signing' ? 'signing…' : 'pending — waiting for the receipt…'}
          </Text>
        )}

        {phase === 'done' && (
          <Box>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.success}
              letterSpacing="0.08em"
              mt={SPACING.base}
            >
              {(config.done ?? 'Settled') + ' · mock chain'}
            </Text>
            <Button
              mt={SPACING.md}
              borderRadius={0}
              bg="transparent"
              color={SEMANTIC_COLORS.textSecondary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.14em"
              py={SPACING.sm}
              px={SPACING.base}
              _hover={{ borderColor: SEMANTIC_COLORS.textSecondary }}
              _focus={FOCUS_STYLES.ring}
              transition={TRANSITIONS.colors}
              onClick={onClose}
            >
              Close
            </Button>
          </Box>
        )}
      </Box>
    </Flex>
  )
}

export default ExecSheet
