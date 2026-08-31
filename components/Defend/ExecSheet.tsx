import React, { useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Modal,
  ModalContent,
  ModalOverlay,
  Text,
  VStack,
} from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { ExecConfig } from './types'

type Phase = 'confirm' | 'signing' | 'pending' | 'done'

export interface ExecSheetProps {
  config: ExecConfig | null
  onClose: () => void
}

/**
 * The one confirmation an irreversible action gets (VETERAN_UX_RULESET V6):
 * numbers, not prose; then pending; then settled. Ported from the proto's
 * `window.__exec` sheet. Mock chain, real choreography.
 */
export const ExecSheet: React.FC<ExecSheetProps> = ({ config, onClose }) => {
  const [phase, setPhase] = useState<Phase>('confirm')
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  // Reset to the confirm phase each time a fresh sheet opens.
  useEffect(() => {
    if (config) setPhase('confirm')
  }, [config])

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout)
    },
    [],
  )

  if (!config) return null

  const runSignature = () => {
    setPhase('signing')
    timers.current.push(
      setTimeout(() => {
        setPhase('pending')
        timers.current.push(setTimeout(() => setPhase('done'), 1100))
      }, 800),
    )
  }

  const pending = phase === 'signing' || phase === 'pending'

  return (
    <Modal isOpen isCentered onClose={onClose} size="md">
      <ModalOverlay bg="rgba(7,7,8,0.78)" />
      <ModalContent
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        borderRadius={0}
        p={SPACING.lg}
        maxW="430px"
        boxShadow="none"
      >
        <Text
          as="h3"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h3}
          color={SEMANTIC_COLORS.textPrimary}
          mb={SPACING.md}
        >
          {config.title}
        </Text>

        <VStack spacing={0} align="stretch">
          {config.rows.map((r, i) => (
            <Box
              key={i}
              display="flex"
              justifyContent="space-between"
              gap={SPACING.base}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textSecondary}
              py={SPACING.xs}
              borderBottom={i < config.rows.length - 1 ? '1px solid' : undefined}
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Text as="span" fontFamily={TYPOGRAPHY.fontMono}>
                {r.label}
              </Text>
              <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
                {r.value}
              </Text>
            </Box>
          ))}
        </VStack>

        {config.note && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight={1.6}
            mt={SPACING.md}
          >
            {config.note}
          </Text>
        )}

        {phase === 'confirm' && (
          <Box display="flex" gap={SPACING.sm} mt={SPACING.base}>
            <Button
              flex={1}
              onClick={runSignature}
              bg={SEMANTIC_COLORS.success}
              color={SEMANTIC_COLORS.bgPrimary}
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              letterSpacing="0.14em"
              textTransform="uppercase"
              transition={TRANSITIONS.colors}
              _hover={{ bg: SEMANTIC_COLORS.success }}
              _focus={FOCUS_STYLES.ring}
            >
              {config.cta ?? 'Confirm'}
            </Button>
            <Button
              onClick={onClose}
              bg="transparent"
              color={SEMANTIC_COLORS.textSecondary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              letterSpacing="0.14em"
              textTransform="uppercase"
              transition={TRANSITIONS.colors}
              _hover={{ color: SEMANTIC_COLORS.textPrimary }}
              _focus={FOCUS_STYLES.ring}
            >
              Cancel
            </Button>
          </Box>
        )}

        {pending && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.warning}
            letterSpacing="0.08em"
            mt={SPACING.base}
          >
            {phase === 'signing' ? 'signing…' : 'pending — waiting for the receipt…'}
          </Text>
        )}

        {phase === 'done' && (
          <>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.success}
              letterSpacing="0.08em"
              mt={SPACING.base}
            >
              {(config.done ?? 'Settled') + ' · mock chain'}
            </Text>
            <Button
              onClick={onClose}
              mt={SPACING.md}
              alignSelf="flex-start"
              bg="transparent"
              color={SEMANTIC_COLORS.textSecondary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              letterSpacing="0.14em"
              textTransform="uppercase"
              transition={TRANSITIONS.colors}
              _hover={{ color: SEMANTIC_COLORS.textPrimary }}
              _focus={FOCUS_STYLES.ring}
            >
              Close
            </Button>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}

export default ExecSheet
