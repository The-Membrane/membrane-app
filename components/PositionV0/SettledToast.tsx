// THE SETTLED TOAST (owner, Q27 round 5). Once a lever settles the order slip closes and
// this says what happened, top right, over the page:
//
//   ● Repaid 760 USDT · new line $1,883 · view tx ↗                         ×
//
// It fades out after TOAST_MS (lib/position-exec/toastTimer.ts); the clock stops while the
// pointer is over it or focus is inside it; × dismisses it. role="status" with
// aria-live="polite": a screen reader hears it once, without interrupting.

import React, { useEffect, useRef, useState } from 'react'
import { Box, Button, Link } from '@chakra-ui/react'
import { mainnet } from 'viem/chains'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { getTxExplorerUrl } from '@/helpers/explorer'
import { TOAST_MS, pausableTimer, type PausableTimer } from '@/lib/position-exec/toastTimer'

import type { SettledToastData } from './leverExec'
import { Mono } from './primitives'
import { TYPE } from './typeScale'

/** The fade at the end: the toast's last FADE_MS go to opacity 0 (TRANSITIONS.opacity runs inside it). */
const FADE_MS = 400

export const SettledToast: React.FC<{
  toast: SettledToastData
  onDone: () => void
  /** Design harness only: keep it on screen (the timer still pauses and resumes). */
  hold?: boolean
}> = ({ toast, onDone, hold = false }) => {
  const [fading, setFading] = useState(false)
  const timer = useRef<PausableTimer | null>(null)
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    if (hold) return
    setFading(false)
    const fade = pausableTimer(TOAST_MS - FADE_MS, () => {
      setFading(true)
      timer.current = pausableTimer(FADE_MS, () => done.current())
    })
    timer.current = fade
    return () => {
      fade.stop()
      timer.current?.stop()
    }
  }, [toast.hash, hold])

  const pause = () => {
    timer.current?.pause()
    setFading(false)
  }
  const resume = () => timer.current?.resume()

  return (
    <Box
      role="status"
      aria-live="polite"
      data-testid="settled-toast"
      position="fixed"
      top={SPACING.base}
      right={SPACING.base}
      left={{ base: SPACING.base, md: 'auto' }}
      zIndex={1500}
      maxW={{ base: 'none', md: '420px' }}
      bg={NEWS.card}
      color={NEWS.ink}
      border={`2px solid ${NEWS.ink}`}
      boxShadow={NEWS.shadowRaised}
      display="grid"
      gridTemplateColumns="1.5em minmax(0, 1fr) 44px"
      alignItems="center"
      columnGap={SPACING.xs}
      pl={SPACING.sm}
      opacity={fading ? 0 : 1}
      transition={TRANSITIONS.opacity}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <Mono aria-hidden fontWeight={700} color={NEWS.ink}>
        ●
      </Mono>
      <Mono fontWeight={700} overflowWrap="anywhere" py={SPACING.sm}>
        {toast.text} ·{' '}
        <Link
          href={getTxExplorerUrl(mainnet, toast.hash)}
          isExternal
          color={NEWS.accent}
          textDecoration="underline"
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPE.body}
          _focusVisible={FOCUS_STYLES.ring}
        >
          view tx ↗
        </Link>
      </Mono>
      <Button
        aria-label="Dismiss"
        onClick={() => done.current()}
        variant="unstyled"
        w="44px"
        h="44px"
        minW="44px"
        borderRadius={0}
        fontFamily={NEWS_FONT.mono}
        fontSize={TYPE.head}
        lineHeight={1}
        color={NEWS.ink}
        transition={TRANSITIONS.colors}
        _hover={{ color: NEWS.accent }}
        _focusVisible={FOCUS_STYLES.ring}
      >
        ×
      </Button>
    </Box>
  )
}
