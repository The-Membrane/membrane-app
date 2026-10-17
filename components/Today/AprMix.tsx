import React, { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Box,
  Flex,
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Portal,
  Text,
} from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { CAPS, TABULAR } from './newsStyle'
import { OPP_COPY, REWARDS_MARK, type AprMix, type MixTimeline } from './opportunitiesView'

// AN APR THAT INCLUDES REWARDS: the figure, dotted-underlined with the ‡ mark, opens its
// composition (venue rate + each reward = total) and each reward's dates. It opens on
// hover, on keyboard focus and on tap (390px has no hover); Escape, blur, leaving it or a
// tap elsewhere closes it. A base-only APR is plain text and never comes here. Words and
// figures come from opportunitiesView.ts aprMix; the popover is ink on paper, as calm is.

const LABEL = {
  fontFamily: NEWS_FONT.mono,
  fontSize: TYPOGRAPHY.label,
  lineHeight: '16px',
  color: NEWS.muted,
  ...CAPS,
}
const VALUE = {
  fontFamily: NEWS_FONT.mono,
  fontSize: '13px',
  lineHeight: '20px',
  color: NEWS.ink,
  sx: TABULAR,
}
/** Chakra's popover scales in; Living Typeface never scales, so this one only fades, at
 *  the colour-transition speeds (.15s in, .1s out; config/transitions.ts). */
const FADE_ONLY = {
  variants: {
    enter: { opacity: 1, transition: { duration: 0.15 } },
    exit: { opacity: 0, transition: { duration: 0.1 } },
  },
}

function Line({
  op,
  label,
  value,
  strong,
}: {
  op: string
  label: ReactNode
  value: string
  strong?: boolean
}) {
  return (
    <Flex justify="space-between" align="baseline" columnGap={SPACING.sm}>
      <Text as="span" {...VALUE} fontWeight={strong ? TYPOGRAPHY.bold : TYPOGRAPHY.normal} minW={0}>
        <Box as="span" display="inline-block" w="1.2em" color={NEWS.muted}>
          {op}
        </Box>
        {label}
      </Text>
      <Text
        as="span"
        {...VALUE}
        fontWeight={strong ? TYPOGRAPHY.bold : TYPOGRAPHY.normal}
        whiteSpace="nowrap"
      >
        {value}
      </Text>
    </Flex>
  )
}

/** One reward's run: start, how much has gone by (the ink), end. Dates only as published. */
function Run({ t }: { t: MixTimeline }) {
  return (
    <Box pt={SPACING.xs}>
      <Text {...VALUE}>{t.token}</Text>
      <Flex align="center" columnGap={SPACING.sm}>
        <Text as="span" {...VALUE} whiteSpace="nowrap">
          {t.start}
        </Text>
        {t.elapsed !== null ? (
          <Box flex="1 1 auto" position="relative" h="8px" aria-hidden="true">
            <Box
              position="absolute"
              left={0}
              right={0}
              top="50%"
              borderTop={`1px solid ${NEWS.ruleStrong}`}
            />
            <Box
              position="absolute"
              left={0}
              top="calc(50% - 1px)"
              h="3px"
              w={`${t.elapsed * 100}%`}
              bg={NEWS.ink}
            />
            <Box
              position="absolute"
              left={`calc(${t.elapsed * 100}% - 0.5px)`}
              top={0}
              bottom={0}
              borderLeft={`1px solid ${NEWS.ink}`}
            />
          </Box>
        ) : (
          <Box flex="1 1 auto" borderTop={`1px dotted ${NEWS.ruleStrong}`} aria-hidden="true" />
        )}
        <Text as="span" {...VALUE} whiteSpace="nowrap">
          {t.end}
        </Text>
      </Flex>
      <Text {...LABEL} textAlign="right">
        {t.left}
      </Text>
    </Box>
  )
}

function MixBody({ mix }: { mix: AprMix }) {
  return (
    <Box>
      <Text {...LABEL}>{mix.title}</Text>
      <Box pt={SPACING.xs} borderBottom={`1px solid ${NEWS.rule}`} pb={SPACING.xs}>
        <Line op="" label={OPP_COPY.mixBase} value={mix.base} />
        {mix.parts.map((p, i) => (
          <Box key={`${p.token}-${i}`}>
            <Line
              op="+"
              label={
                <>
                  {p.token}
                  <Box as="span" color={NEWS.muted}>
                    {' '}
                    · {p.source}
                  </Box>
                </>
              }
              value={p.apr}
            />
            {p.note && (
              <Text {...LABEL} textTransform="none" letterSpacing="normal" pl="1.2em">
                {p.note}
              </Text>
            )}
          </Box>
        ))}
      </Box>
      <Box pt={SPACING.xs}>
        <Line op="=" label={OPP_COPY.mixTotal} value={`${mix.total}${REWARDS_MARK}`} strong />
      </Box>
      {mix.timeline.length > 0 && (
        <Box pt={SPACING.sm}>
          <Text {...LABEL}>{OPP_COPY.mixTimeline}</Text>
          {mix.timeline.map((t, i) => (
            <Run key={`${t.token}-${i}`} t={t} />
          ))}
        </Box>
      )}
      <Text {...LABEL} textTransform="none" letterSpacing="normal" pt={SPACING.sm}>
        {mix.unknown}
      </Text>
      <Text
        {...LABEL}
        textTransform="none"
        letterSpacing="normal"
        pt={SPACING.xs}
        overflowWrap="anywhere"
      >
        {mix.credit}
      </Text>
    </Box>
  )
}

export interface MixedAprProps {
  mix: AprMix
  /** The figure as it reads in place (a headline Figure, or a table value). */
  children: ReactNode
}

/** The figure plus its ‡, as a button that opens the composition. */
export const MixedApr = memo(function MixedApr({ mix, children }: MixedAprProps) {
  const [open, setOpen] = useState(false)
  const pointer = useRef('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // A tap elsewhere closes it: touch browsers do not always blur the trigger or leave it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || contentRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  return (
    <Popover
      isOpen={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      // Hover and focus open it (Chakra's hover trigger); the click below adds the tap.
      trigger="hover"
      openDelay={80}
      closeDelay={150}
      placement="bottom-start"
      gutter={6}
      isLazy
      autoFocus={false}
      returnFocusOnClose={false}
      closeOnBlur
    >
      <PopoverTrigger>
        <Box
          as="button"
          type="button"
          ref={triggerRef}
          aria-label={mix.spoken}
          data-apr-mix=""
          onPointerDown={(e: React.PointerEvent) => {
            pointer.current = e.pointerType
          }}
          onClick={(e: React.MouseEvent) => {
            // A mouse has already opened it by hovering; a tap, a pen or a key (detail 0)
            // toggles it.
            if (e.detail !== 0 && pointer.current === 'mouse') setOpen(true)
            else setOpen((o) => !o)
          }}
          position="relative"
          display="inline"
          p={0}
          color="inherit"
          whiteSpace="nowrap"
          textAlign="inherit"
          bg="transparent"
          cursor="help"
          textDecorationLine="underline"
          textDecorationStyle="dotted"
          textDecorationThickness="1px"
          textUnderlineOffset="4px"
          transition={TRANSITIONS.colors}
          _hover={{ color: NEWS.accent }}
          // The 44px target, without moving the line it sits on.
          _after={{ content: '""', position: 'absolute', inset: '-14px -4px' }}
          sx={{ font: 'inherit' }}
        >
          {children}
          {/* Inline at the figure's size, as the † is (no new type step, never under
              11px); inline-block keeps the dotted underline off the mark. */}
          <Box as="span" aria-hidden="true" display="inline-block">
            {REWARDS_MARK}
          </Box>
        </Box>
      </PopoverTrigger>
      <Portal>
        <PopoverContent
          ref={contentRef}
          data-apr-mix-panel=""
          motionProps={FADE_ONLY}
          w="min(320px, calc(100vw - 32px))"
          bg={NEWS.paper}
          color={NEWS.ink}
          border={`1px solid ${NEWS.ink}`}
          borderRadius={0}
          boxShadow="none"
          _focusVisible={{ outline: `2px solid ${NEWS.ink}`, outlineOffset: '2px' }}
        >
          <PopoverBody p={SPACING.md}>
            <MixBody mix={mix} />
          </PopoverBody>
        </PopoverContent>
      </Portal>
    </Popover>
  )
})

export default MixedApr
