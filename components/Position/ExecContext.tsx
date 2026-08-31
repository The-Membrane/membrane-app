import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Box, Button, HStack, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DemoAwareCta } from '@/components/demo'

import { withAlpha } from './utils'
import { ExecPayload } from './types'

/**
 * Execution layer (ported from the `window.__exec` confirm sheet in
 * public/proto/dash.html): the one confirmation an irreversible action gets —
 * numbers, not prose; then signing; then pending; then settled. The proto's
 * demo wrapper (which swapped the CTA to "Connect wallet" and replayed the
 * intent) is replaced by the shared DemoAwareCta seam on each trigger, so the
 * sheet itself only ever opens post-connect for the real signature.
 */

type Phase = 'confirm' | 'signing' | 'pending' | 'done'

interface ExecContextValue {
  openExec: (payload: ExecPayload) => void
}

const ExecCtx = createContext<ExecContextValue | null>(null)

export const useExec = (): ExecContextValue => {
  const ctx = useContext(ExecCtx)
  if (!ctx) throw new Error('useExec must be used within an ExecProvider')
  return ctx
}

export const ExecProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [payload, setPayload] = useState<ExecPayload | null>(null)
  const [phase, setPhase] = useState<Phase>('confirm')

  const openExec = useCallback((p: ExecPayload) => {
    setPayload(p)
    setPhase('confirm')
  }, [])

  const close = useCallback(() => setPayload(null), [])

  // signing → pending → done choreography (mock chain, real cadence).
  useEffect(() => {
    if (phase === 'signing') {
      const t = setTimeout(() => setPhase('pending'), 800)
      return () => clearTimeout(t)
    }
    if (phase === 'pending') {
      const t = setTimeout(() => setPhase('done'), 1100)
      return () => clearTimeout(t)
    }
  }, [phase])

  const value = useMemo(() => ({ openExec }), [openExec])

  return (
    <ExecCtx.Provider value={value}>
      {children}
      {payload && (
        <Box
          position="fixed"
          inset={0}
          bg={withAlpha(SEMANTIC_COLORS.bgPrimary, 0.78)}
          display="grid"
          placeItems="center"
          zIndex={60}
          onClick={close}
        >
          <Box
            bg={SEMANTIC_COLORS.bgSecondary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            p={SPACING.lg}
            w="min(430px, 92vw)"
            onClick={(e) => e.stopPropagation()}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontDisplay}
              fontSize={TYPOGRAPHY.h3}
              color={SEMANTIC_COLORS.textPrimary}
              mb={SPACING.md}
            >
              {payload.title}
            </Text>

            <VStack align="stretch" spacing={0}>
              {payload.rows.map(([k, v], i) => (
                <HStack
                  key={i}
                  justify="space-between"
                  spacing={SPACING.base}
                  py={SPACING.xs}
                  borderBottom={i === payload.rows.length - 1 ? 'none' : '1px solid'}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                >
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                    {k}
                  </Text>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textPrimary}>
                    {v}
                  </Text>
                </HStack>
              ))}
            </VStack>

            {payload.note && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textTertiary}
                lineHeight={1.6}
                mt={SPACING.md}
              >
                {payload.note}
              </Text>
            )}

            {phase === 'confirm' && (
              <HStack spacing={SPACING.sm} mt={SPACING.base}>
                <Button
                  flex={1}
                  borderRadius={0}
                  bg={SEMANTIC_COLORS.success}
                  color={SEMANTIC_COLORS.bgPrimary}
                  _hover={{ bg: SEMANTIC_COLORS.success }}
                  _focus={FOCUS_STYLES.ring}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  letterSpacing="0.14em"
                  textTransform="uppercase"
                  py={SPACING.md}
                  height="auto"
                  onClick={() => setPhase('signing')}
                >
                  {payload.cta ?? 'Confirm'}
                </Button>
                <Button
                  borderRadius={0}
                  variant="outline"
                  border="1px solid"
                  borderColor={SEMANTIC_COLORS.borderStrong}
                  bg="transparent"
                  color={SEMANTIC_COLORS.textSecondary}
                  _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
                  _focus={FOCUS_STYLES.ring}
                  transition={TRANSITIONS.colors}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  letterSpacing="0.14em"
                  textTransform="uppercase"
                  py={SPACING.md}
                  height="auto"
                  onClick={close}
                >
                  Cancel
                </Button>
              </HStack>
            )}

            {(phase === 'signing' || phase === 'pending') && (
              <Text
                mt={SPACING.base}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.warning}
                letterSpacing="0.08em"
              >
                {phase === 'signing' ? 'signing…' : 'pending — waiting for the receipt…'}
              </Text>
            )}

            {phase === 'done' && (
              <>
                <Text
                  mt={SPACING.base}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.success}
                  letterSpacing="0.08em"
                >
                  {(payload.done ?? 'Settled') + ' · mock chain'}
                </Text>
                <Button
                  mt={SPACING.md}
                  borderRadius={0}
                  variant="outline"
                  border="1px solid"
                  borderColor={SEMANTIC_COLORS.borderStrong}
                  bg="transparent"
                  color={SEMANTIC_COLORS.textSecondary}
                  _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
                  _focus={FOCUS_STYLES.ring}
                  transition={TRANSITIONS.colors}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  letterSpacing="0.14em"
                  textTransform="uppercase"
                  onClick={close}
                >
                  Close
                </Button>
              </>
            )}
          </Box>
        </Box>
      )}
    </ExecCtx.Provider>
  )
}

/**
 * A transact CTA that opens the confirm sheet. Uses DemoAwareCta so that in demo
 * mode it reads "Connect wallet", stores the intent, connects, then opens the
 * sheet for the real signature — every irreversible action gets exactly one.
 */
export const ExecButton: React.FC<{
  payload: ExecPayload
  children: React.ReactNode
  variant?: 'go' | 'ghost'
  ml?: number
}> = ({ payload, children, variant = 'ghost', ml }) => {
  const { openExec } = useExec()
  const go = variant === 'go'
  return (
    <DemoAwareCta
      onAction={() => openExec(payload)}
      ml={ml}
      height="auto"
      bg={go ? SEMANTIC_COLORS.success : 'transparent'}
      color={go ? SEMANTIC_COLORS.bgPrimary : SEMANTIC_COLORS.textPrimary}
      border="1px solid"
      borderColor={go ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderStrong}
      _hover={
        go
          ? { bg: SEMANTIC_COLORS.success }
          : { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }
      }
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="9.5px"
      letterSpacing="0.14em"
      textTransform="uppercase"
      px={SPACING.md}
      py={SPACING.sm}
      minW="auto"
    >
      {children}
    </DemoAwareCta>
  )
}
