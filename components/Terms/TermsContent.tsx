import React from 'react'
import { Box, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

/**
 * Shared renderer for the Terms of Service markdown in `public/TOS.md`.
 *
 * Deliberately a tiny parser rather than a markdown dependency: the document uses
 * six constructs (h1, h2, hr, ordered/unordered lists, bold spans) and pulling in a
 * renderer for that is more surface than it is worth.
 *
 * Two things it fixes versus the parser previously inlined in StorefrontTOSModal:
 * consecutive list items are grouped into a real <ul>/<ol> instead of emitting
 * orphan <li> elements, and the styling follows Living Typeface — serif headings,
 * mono body, hairline rules, no glow.
 */

type Block =
  | { kind: 'h1'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'hr' }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'p'; text: string }

/** Splits `**bold**` runs out of a line and emphasises them in phosphor. */
const withEmphasis = (line: string) =>
  line.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? (
      <Text as="span" key={`${part}-${i}`} color={SEMANTIC_COLORS.primary} fontWeight={TYPOGRAPHY.medium}>
        {part}
      </Text>
    ) : (
      <React.Fragment key={`${part}-${i}`}>{part}</React.Fragment>
    ),
  )

export const parseTerms = (markdown: string): Block[] => {
  const blocks: Block[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flush = () => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
      list = null
    }
  }

  markdown.split('\n').forEach((raw) => {
    const line = raw.trim()

    const bullet = /^[-•]\s+(.*)$/.exec(line)
    const numbered = /^\d+\.\s+(.*)$/.exec(line)

    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const text = (bullet?.[1] ?? numbered?.[1] ?? '').trim()
      // A change of list type starts a new list rather than mixing markers.
      if (!list || list.ordered !== ordered) {
        flush()
        list = { ordered, items: [] }
      }
      list.items.push(text)
      return
    }

    flush()
    if (line === '') return
    if (line === '---') { blocks.push({ kind: 'hr' }); return }
    if (line.startsWith('# ')) { blocks.push({ kind: 'h1', text: line.slice(2).trim() }); return }
    if (line.startsWith('## ')) { blocks.push({ kind: 'h2', text: line.slice(3).trim() }); return }
    blocks.push({ kind: 'p', text: line })
  })

  flush()
  return blocks
}

/** Pulls the `**Last Updated:** M/D/YYYY` line out as an ISO-ish version string. */
export const termsVersion = (markdown: string): string | null => {
  const m = /\*\*Last Updated:\*\*\s*([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})/.exec(markdown)
  if (!m) return null
  const [, mm, dd, yyyy] = m
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}

export const TermsContent = ({ markdown }: { markdown: string }) => {
  const blocks = React.useMemo(() => parseTerms(markdown), [markdown])

  return (
    <VStack spacing={SPACING.base} align="stretch">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'h1':
            return (
              <Text
                key={`h1-${block.text}`}
                as="h1"
                fontFamily="heading"
                fontSize={TYPOGRAPHY.h1}
                color={SEMANTIC_COLORS.textPrimary}
                mt={i === 0 ? 0 : SPACING.lg}
              >
                {block.text}
              </Text>
            )

          case 'h2':
            return (
              <Text
                key={`h2-${block.text}`}
                as="h2"
                fontFamily="heading"
                fontSize={TYPOGRAPHY.h3}
                color={SEMANTIC_COLORS.textPrimary}
                mt={SPACING.base}
              >
                {block.text}
              </Text>
            )

          case 'hr':
            // Index is the only stable key here: dividers are identical, stateless,
            // and this list is a full re-parse of static text that never reorders.
            return <Box key={`hr-${i}`} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} my={SPACING.sm} />

          case 'list':
            return (
              <Box
                key={`list-${i}`}
                as={block.ordered ? 'ol' : 'ul'}
                pl={SPACING.lg}
                display="grid"
                gap={SPACING.xs}
              >
                {block.items.map((item) => (
                  <Text
                    as="li"
                    key={item}
                    fontFamily="mono"
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textPrimary}
                    lineHeight="1.7"
                  >
                    {withEmphasis(item)}
                  </Text>
                ))}
              </Box>
            )

          default:
            return (
              <Text
                key={`p-${block.text.slice(0, 48)}-${i}`}
                fontFamily="mono"
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textPrimary}
                lineHeight="1.8"
              >
                {withEmphasis(block.text)}
              </Text>
            )
        }
      })}
    </VStack>
  )
}

export default TermsContent
