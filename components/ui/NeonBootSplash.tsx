import { Box } from '@chakra-ui/react'
import React, { useEffect, useState } from 'react'

/**
 * Boot splash: the neon "THE MEMBRANE" sign from the retired storefront
 * landing page, kept alive as the first-load screen (owner request: the sign
 * is loved, the page it lived on is not).
 *
 * Renders server-side so it covers the blank pre-hydration window, then fades
 * once React mounts. Hard page loads only — it never re-appears on client-side
 * route changes because the mounted instance transitions to 'gone' and stays.
 *
 * The room is always near-black regardless of theme: neon only reads in the
 * dark, and a short dark boot beat into a parchment app reads as a deliberate
 * reveal. Sign styling (Neon Tubes font, cyan glow, blink) comes from the
 * existing .neonSignon rules in styles/global.css. Cyan is legacy-palette but
 * sanctioned here: the splash is a display-only atmosphere layer, not chrome.
 */

const MIN_SHOW_MS = 900
const FADE_MS = 450

const NeonBootSplash = () => {
  const [phase, setPhase] = useState<'shown' | 'fading' | 'gone'>('shown')

  useEffect(() => {
    const fadeTimer = setTimeout(() => setPhase('fading'), MIN_SHOW_MS)
    const goneTimer = setTimeout(() => setPhase('gone'), MIN_SHOW_MS + FADE_MS)
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(goneTimer)
    }
  }, [])

  if (phase === 'gone') return null

  return (
    <Box
      role="status"
      aria-label="Loading The Membrane"
      position="fixed"
      inset={0}
      zIndex={9999}
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="#09090a"
      opacity={phase === 'fading' ? 0 : 1}
      transition={`opacity ${FADE_MS}ms ease-out`}
      pointerEvents={phase === 'fading' ? 'none' : 'auto'}
    >
      <Box
        className="neonSignon"
        letterSpacing="wider"
        textAlign="center"
        display="flex"
        flexDirection={{ base: 'column', md: 'row' }}
        justifyContent="center"
        alignItems="center"
        gap={{ base: 0, md: '0.2em' }}
        aria-hidden="true"
      >
        <b style={{ display: 'flex' }}>
          <span>T</span>
          <span>H</span>
          <span>E</span>
        </b>
        <b style={{ display: 'flex' }}>
          <i style={{ display: 'inline-block', fontSize: 'clamp(75px, 4vh, 4vh)', fontStyle: 'normal' }}>M</i>
          <span>E</span>
          <span>M</span>
          <i style={{ display: 'inline-block', fontSize: 'clamp(75px, 4vh, 4vh)', fontStyle: 'normal' }}>B</i>
          <i style={{ display: 'inline-block', fontSize: 'clamp(75px, 4vh, 4vh)', fontStyle: 'normal' }}>R</i>
          <span>A</span>
          <i style={{ display: 'inline-block', fontSize: 'clamp(75px, 4vh, 4vh)', fontStyle: 'normal' }}>N</i>
          <span>E</span>
        </b>
      </Box>
    </Box>
  )
}

export default NeonBootSplash
