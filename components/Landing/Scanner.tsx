import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, Lede } from './atoms'
import { TIERS } from './fixtures'

const HOLD_MS = 1400

interface Props {
  chainName: string
}

/**
 * Press-and-hold "scan" ritual ported from the proto's scanpad. A determinate
 * progress fill runs while held (pointer or Space/Enter); completing it opens
 * the risk desk at `/${chainName}/defend`. Motion is determinate feedback only
 * — no infinite sweep, no glow (Living Typeface rule).
 */
export const Scanner: React.FC<Props> = ({ chainName }) => {
  const router = useRouter()
  const [progress, setProgress] = useState(0)
  const [scanning, setScanning] = useState(false)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)
  const doneRef = useRef(false)

  const stopRaf = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }

  const tick = useCallback(
    (now: number) => {
      const p = Math.min(1, (now - startRef.current) / HOLD_MS)
      setProgress(p)
      if (p >= 1) {
        doneRef.current = true
        stopRaf()
        setScanning(false)
        router.push(`/${chainName}/defend`)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [chainName, router]
  )

  const start = useCallback(() => {
    if (scanning || doneRef.current) return
    setScanning(true)
    startRef.current = performance.now()
    rafRef.current = requestAnimationFrame(tick)
  }, [scanning, tick])

  const cancel = useCallback(() => {
    if (doneRef.current) return
    stopRaf()
    setScanning(false)
    setProgress(0)
  }, [])

  useEffect(() => () => stopRaf(), [])

  const hint = scanning ? 'Reading…' : 'Hold to scan'

  return (
    <Box as="section" display="grid" gap={SPACING.lg}>
      <Box display="grid" gap={SPACING.md}>
        <Eyebrow>Deeper in</Eyebrow>
        <Text as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontWeight={TYPOGRAPHY.normal} fontSize={{ base: '21px', md: '30px' }} lineHeight="1.15" color={SEMANTIC_COLORS.textPrimary}>
          Past borrowing, there is a second job
        </Text>
        <Lede>
          Judging the people who set risk parameters — then setting them yourself. That layer stays shut until you open it.
        </Lede>
      </Box>

      <Box
        display="grid"
        gridTemplateColumns={{ base: '1fr', md: 'auto 1fr' }}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        bg={SEMANTIC_COLORS.bgSecondary}
        overflow="hidden"
      >
        {/* scanpad */}
        <Box
          role="button"
          tabIndex={0}
          aria-label="Hold to scan"
          onPointerDown={(e) => {
            e.preventDefault()
            start()
          }}
          onPointerUp={cancel}
          onPointerLeave={cancel}
          onPointerCancel={cancel}
          onKeyDown={(e) => {
            if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
              e.preventDefault()
              start()
            }
          }}
          onKeyUp={cancel}
          w={{ base: 'auto', md: 'clamp(150px, 20vw, 210px)' }}
          bg={SEMANTIC_COLORS.bgPrimary}
          borderRight={{ base: 'none', md: '1px solid' }}
          borderBottom={{ base: '1px solid', md: 'none' }}
          borderColor={SEMANTIC_COLORS.borderSubtle}
          display="grid"
          placeItems="center"
          p={SPACING.lg}
          position="relative"
          cursor="pointer"
          userSelect="none"
          transition={TRANSITIONS.colors}
          _focusVisible={FOCUS_STYLES.ring}
        >
          <Box w="82px" h="82px" position="relative">
            <Box
              as="svg"
              viewBox="0 0 100 100"
              width="100%"
              height="100%"
              display="block"
              aria-hidden="true"
              sx={{
                path: {
                  fill: 'none',
                  stroke: scanning ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary,
                  strokeWidth: 1.6,
                  transition: 'stroke 0.3s',
                },
              }}
            >
              <path d="M50 12c-21 0-38 17-38 38v12" />
              <path d="M50 24c-14.4 0-26 11.6-26 26v18" />
              <path d="M50 36c-7.7 0-14 6.3-14 14v26" />
              <path d="M50 48c-1.1 0-2 .9-2 2v34" />
              <path d="M50 12c21 0 38 17 38 38v12" />
              <path d="M50 24c14.4 0 26 11.6 26 26v18" />
              <path d="M50 36c7.7 0 14 6.3 14 14v26" />
              <path d="M62 62v18" />
              <path d="M76 74v10" />
              <path d="M36 70v14" />
              <path d="M24 78v8" />
            </Box>
          </Box>

          {/* determinate progress fill */}
          <Box position="absolute" bottom={0} left={0} h="2px" w={`${progress * 100}%`} bg={SEMANTIC_COLORS.success} transition="width 0.05s linear" />

          <Text position="absolute" bottom="14px" left={0} right={0} textAlign="center" fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.22em" textTransform="uppercase" color={scanning ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}>
            {hint}
          </Text>
        </Box>

        {/* lock body */}
        <Box p={SPACING.lg} display="grid" gap={SPACING.md} alignContent="center">
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="19px" color={SEMANTIC_COLORS.textPrimary}>
            Risk desk — sealed
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} maxW="60ch" lineHeight="1.6">
            Read a curator’s doctrine, catch it drifting from its mandate, size across several of them. Author your own once you can judge someone
            else’s.
          </Text>

          <Box display="grid" gap="1px" bg={SEMANTIC_COLORS.borderSubtle} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt={SPACING.xs}>
            {TIERS.map((t) => {
              const open = !!t.always
              return (
                <Box key={t.nm} bg={SEMANTIC_COLORS.bgSecondary} px={SPACING.md} py={SPACING.sm} display="flex" justifyContent="space-between" gap={SPACING.md} alignItems="baseline" fontSize="11.5px">
                  <Text fontFamily={TYPOGRAPHY.fontMono} color={open ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}>
                    {t.nm}
                  </Text>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.2em" textTransform="uppercase" color={open ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}>
                    {open ? 'Open' : 'Sealed'}
                  </Text>
                </Box>
              )
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default Scanner
