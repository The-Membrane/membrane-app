import React, { useEffect, useRef, useState } from 'react'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { MockStamp } from '@/components/demo'

import { Eyebrow, Warm } from './primitives'
import { FEED, LANE_RATE, LIFE, RATE_MO, VENUES } from './fixtures'
import { CLASS_COLOR, createBeltAnimation, lifeBlocks, lifeStartIndex, usdc } from './utils'
import { Venue } from './types'

// ---------- lifestyle equivalence ----------
const LifestyleEquivalence: React.FC = () => {
  const [idx, setIdx] = useState(() => lifeStartIndex(RATE_MO, LIFE))
  const x = LIFE[idx]
  const cover = RATE_MO / x.mo
  const { full, frac, overflow } = lifeBlocks(cover)

  const blocks = (
    <HStack as="span" spacing="3px" mx={SPACING.sm} verticalAlign="-1px" display="inline-flex">
      {Array.from({ length: full }).map((_, i) => (
        <Box key={`f${i}`} as="span" display="inline-block" w="9px" h="9px" border="1px solid" borderColor={SEMANTIC_COLORS.success} bg={SEMANTIC_COLORS.success} />
      ))}
      {frac > 0 && (
        <Box key="frac" as="span" display="inline-block" w="9px" h="9px" border="1px solid" borderColor={SEMANTIC_COLORS.success} position="relative" overflow="hidden">
          <Box as="span" position="absolute" left={0} top={0} bottom={0} w={`${(frac * 100).toFixed(0)}%`} bg={SEMANTIC_COLORS.success} />
        </Box>
      )}
      {overflow > 0 && (
        <Box as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.success}>
          +{overflow}
        </Box>
      )}
    </HStack>
  )

  return (
    <Box
      as="button"
      type="button"
      aria-label="Cycle what the yield covers"
      display="block"
      w="100%"
      textAlign="left"
      bg={SEMANTIC_COLORS.bgPrimary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p="10px 14px"
      mt="10px"
      cursor="pointer"
      transition={TRANSITIONS.colors}
      _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
      onClick={() => setIdx((i) => (i + 1) % LIFE.length)}
    >
      <Text as="span" display="block" fontFamily={TYPOGRAPHY.fontMono} fontSize="12.5px" color={SEMANTIC_COLORS.textPrimary}>
        {cover >= 1 ? (
          <>
            your yield covers{' '}
            <Box as="span" fontWeight={400} color={SEMANTIC_COLORS.success}>
              {cover.toFixed(1).replace(/\.0$/, '')}× {x.nm}
            </Box>
            {blocks}
            at the measured rate paid continuously
          </>
        ) : (
          <>
            your yield pays{' '}
            <Box as="span" fontWeight={400} color={SEMANTIC_COLORS.success}>
              {(cover * 100).toFixed(0)}% of {x.nm}
            </Box>
            {blocks}
            at the measured rate paid continuously
          </>
        )}
      </Text>
      <Text as="span" display="block" fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.12em" mt="4px">
        ${RATE_MO.toFixed(0)}/mo is a rate measured over the last 14 days. Revenue lands every block as it arrives · {x.approx ? '≈' : ''}$
        {x.mo.toLocaleString('en-US')}/mo list price, Aug 2026 · click for the next one · {idx + 1} / {LIFE.length}
      </Text>
    </Box>
  )
}

// ---------- venue drawer row ----------
const VenueRow: React.FC<{ v: Venue }> = ({ v }) => {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const copy = (val: string) => {
    try {
      navigator.clipboard.writeText(val)
    } catch {
      /* ignore */
    }
    setCopied(val)
    setTimeout(() => setCopied(null), 900)
  }

  const fact = (label: string, node: React.ReactNode) => (
    <HStack justify="space-between" spacing={SPACING.md} fontSize="10.5px" color={SEMANTIC_COLORS.textTertiary}>
      <Text as="span">{label}</Text>
      <Box as="span" color={SEMANTIC_COLORS.textSecondary}>
        {node}
      </Box>
    </HStack>
  )

  return (
    <Box borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} _last={{ borderBottom: 'none' }}>
      <Grid
        as="button"
        type="button"
        aria-expanded={open}
        gridTemplateColumns="14px 1fr auto auto auto 16px"
        gap="10px"
        alignItems="baseline"
        w="100%"
        p="11px 10px"
        bg="transparent"
        border={0}
        color={SEMANTIC_COLORS.textPrimary}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11.5px"
        cursor="pointer"
        textAlign="left"
        transition={TRANSITIONS.colors}
        onClick={() => setOpen((o) => !o)}
        _hover={{ '& .vn': { color: SEMANTIC_COLORS.success } }}
      >
        <Box as="span" display="inline-block" w="9px" h="9px" alignSelf="center" bg={CLASS_COLOR[v.cls]} />
        <Box as="span" className="vn" transition={TRANSITIONS.colors}>
          {v.nm}
        </Box>
        <Box as="span" position="relative" w="76px" h="5px" alignSelf="center" bg="color-mix(in srgb, var(--m-text-primary) 7%, transparent)" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          <Box as="span" position="absolute" left={0} top={0} bottom={0} w={v.share} bg={CLASS_COLOR[v.cls]} />
        </Box>
        <Box as="span" fontSize="10.5px" color={SEMANTIC_COLORS.textSecondary}>
          {v.del14}
        </Box>
        <Box as="span" fontSize="10.5px" color={SEMANTIC_COLORS.textSecondary}>
          recall {v.recall}
        </Box>
        <Box as="span" color={SEMANTIC_COLORS.textTertiary} textAlign="right" aria-hidden>
          {open ? '−' : '+'}
        </Box>
      </Grid>
      {open && (
        <Box display="grid" gap="5px" p="2px 34px 12px 34px">
          {fact('State', v.state)}
          {fact('Deployed', `${usdc(v.dep)} · ${v.share} of the stack`)}
          {fact('Deliveries, 14d avg', v.del14)}
          {fact(
            'Contract',
            <Box as="span" cursor="pointer" transition={TRANSITIONS.colors} _hover={{ color: SEMANTIC_COLORS.success }} onClick={() => copy(v.addr)}>
              {copied === v.addr ? 'copied' : `${v.addr} ⧉`}
            </Box>
          )}
          {fact(
            'Site',
            <Box as="span" cursor="pointer" transition={TRANSITIONS.colors} _hover={{ color: SEMANTIC_COLORS.success }} onClick={() => copy(v.home)}>
              {copied === v.home ? 'copied' : `${v.home} ⧉`}
            </Box>
          )}
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.12em" mt="4px">
            measured {v.measured}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// ---------- belt canvas ----------
const BeltCanvas: React.FC = () => {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const anim = createBeltAnimation(LANE_RATE)
    let raf = 0
    let last = 0

    const frame = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      const w = host.clientWidth
      const h = host.clientHeight
      if (w && h) {
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr)
          canvas.height = Math.round(h * dpr)
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        anim.draw(ctx, w, h, dt)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <Box ref={hostRef} id="beltlist" position="relative" mt={SPACING.base} bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} overflow="hidden">
      <Box as="canvas" ref={canvasRef} position="absolute" inset={0} w="100%" h="100%" pointerEvents="none" />
      <Box position="relative" zIndex={1} pr="34px">
        {VENUES.map((v) => (
          <VenueRow key={v.nm} v={v} />
        ))}
      </Box>
    </Box>
  )
}

/** Section 1 — throughput hero + belt + delivery feed. */
export const ThroughputHero: React.FC = () => {
  return (
    <Grid gridTemplateColumns={{ base: '1fr', lg: 'minmax(0,1.35fr) minmax(0,1fr)' }} gap={SPACING.base}>
      <Card>
        <Eyebrow>
          01 / Throughput <MockStamp />
        </Eyebrow>
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '22px', md: '31px' }} lineHeight="1.15" mt="10px" mb="6px" color={SEMANTIC_COLORS.textPrimary}>
          The machine is getting faster.
        </Text>
        <Warm fontFamily={TYPOGRAPHY.fontMono} fontSize="12.5px" color={SEMANTIC_COLORS.textSecondary} maxW="60ch">
          What arrives is already net. The loan’s interest comes out before the yield reaches you. That
          subtraction shrinks as the debt shrinks. So each delivery is a little larger than the last, from the
          same venues at the same rates. The machine speeds up by losing overhead.
        </Warm>

        <HStack align="flex-end" spacing={SPACING.base} m="20px 0 4px" flexWrap="wrap">
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={{ base: '38px', md: '60px' }} lineHeight="0.95" letterSpacing="-0.03em" color={SEMANTIC_COLORS.textPrimary}>
            $10.17
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} pb={SPACING.sm}>
            per day, measured across
            <br />
            the last 14 days of deliveries
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.success}>
            ▲ from $9.27 in your first fortnight · $12.40 at zero debt, if rates hold
          </Text>
        </HStack>

        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary} m="2px 0 0">
          vs just holding:{' '}
          <Box as="span" color={SEMANTIC_COLORS.success} fontWeight={400}>
            +$402 delivered
          </Box>{' '}
          on top of the same BTC · vs selling in January:{' '}
          <Box as="span" color={SEMANTIC_COLORS.success} fontWeight={400}>
            0.19 BTC ahead
          </Box>
          , net of exit cost and tax, both measured
        </Text>

        <LifestyleEquivalence />

        <BeltCanvas />
        <HStack justify="space-between" fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.18em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.sm}>
          <Box as="span">packet size = measured yield · outline = before the loan’s cut</Box>
          <Box as="span">debt</Box>
        </HStack>
      </Card>

      <Card>
        <Eyebrow>
          Belt deliveries <MockStamp />
        </Eyebrow>
        <Box mt={SPACING.md}>
          {FEED.map((f, i) => (
            <Grid
              key={i}
              gridTemplateColumns="auto 1fr auto"
              gap="10px"
              alignItems="baseline"
              py="9px"
              borderBottom={i === FEED.length - 1 ? 'none' : '1px solid'}
              borderColor={SEMANTIC_COLORS.borderSubtle}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11.5px"
            >
              <Text as="span" color={SEMANTIC_COLORS.success}>
                +${f.amt.toFixed(2)}
              </Text>
              <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
                <Box as="span" display="inline-block" w="7px" h="7px" mr="6px" bg={CLASS_COLOR[f.cls]} />
                from{' '}
                <Box as="span" color={SEMANTIC_COLORS.textPrimary}>
                  {f.venue}
                </Box>{' '}
                → {f.eff}
              </Text>
              <Text as="span" color={SEMANTIC_COLORS.textTertiary} fontSize="10px">
                {f.ago}
              </Text>
            </Grid>
          ))}
        </Box>
      </Card>
    </Grid>
  )
}
