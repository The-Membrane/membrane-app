import React from 'react'
import NextLink from 'next/link'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

/**
 * Markdown renderer for blog post bodies. Same philosophy as
 * components/Terms/TermsContent.tsx — a tiny parser instead of a markdown
 * dependency — extended with the constructs posts need beyond the TOS:
 * h3, inline links, and inline code. Post authors write to this subset
 * (##, ###, ---, lists, paragraphs, **bold**, `code`, [text](href)).
 *
 * Styling is Living Typeface: serif headings, mono body, hairline rules.
 */

type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'hr' }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'p'; text: string }

const INLINE_TOKEN = /(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/

/** Renders `code`, **bold**, and [text](href) spans inside a line. */
export const renderInline = (line: string): React.ReactNode[] =>
  line.split(INLINE_TOKEN).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <Text as="span" key={i} color={SEMANTIC_COLORS.primary} fontWeight={TYPOGRAPHY.medium}>
          {part.slice(2, -2)}
        </Text>
      )
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <Text
          as="code"
          key={i}
          px={SPACING.xs}
          fontFamily="mono"
          fontSize="0.9em"
          color={SEMANTIC_COLORS.secondary}
          bg="color-mix(in srgb, var(--m-text-primary) 6%, transparent)"
        >
          {part.slice(1, -1)}
        </Text>
      )
    }
    const link = LINK.exec(part)
    if (link) {
      const [, label, href] = link
      const internal = href.startsWith('/')
      return (
        <Box
          as={internal ? NextLink : 'a'}
          key={i}
          href={href}
          {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          color={SEMANTIC_COLORS.primary}
          textDecoration="underline"
          textUnderlineOffset="3px"
        >
          {label}
        </Box>
      )
    }
    return <React.Fragment key={i}>{part}</React.Fragment>
  })

export const parseBlogMarkdown = (markdown: string): Block[] => {
  const blocks: Block[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  // Source files hard-wrap prose; consecutive plain lines are one paragraph.
  let para: string[] = []

  const flush = () => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
      list = null
    }
    if (para.length) {
      blocks.push({ kind: 'p', text: para.join(' ') })
      para = []
    }
  }

  markdown.split('\n').forEach((raw) => {
    const line = raw.trim()

    const bullet = /^[-•]\s+(.*)$/.exec(line)
    const numbered = /^\d+\.\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      if (!list || list.ordered !== ordered) {
        flush()
        list = { ordered, items: [] }
      } else if (para.length) {
        flush()
        list = { ordered, items: [] }
      }
      list.items.push((bullet?.[1] ?? numbered?.[1] ?? '').trim())
      return
    }

    if (line === '') { flush(); return }
    if (line === '---') { flush(); blocks.push({ kind: 'hr' }); return }
    if (line.startsWith('### ')) { flush(); blocks.push({ kind: 'h3', text: line.slice(4).trim() }); return }
    if (line.startsWith('## ')) { flush(); blocks.push({ kind: 'h2', text: line.slice(3).trim() }); return }
    if (list) {
      // A wrapped continuation of the previous list item, not a new paragraph.
      list.items[list.items.length - 1] += ` ${line}`
      return
    }
    para.push(line)
  })

  flush()
  return blocks
}

export const BlogMarkdown = ({ markdown }: { markdown: string }) => {
  const blocks = React.useMemo(() => parseBlogMarkdown(markdown), [markdown])

  return (
    <Box display="grid" gap={SPACING.base}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'h2':
            return (
              <Text
                key={`h2-${block.text}`}
                as="h2"
                fontFamily="heading"
                fontSize={TYPOGRAPHY.h3}
                color={SEMANTIC_COLORS.textPrimary}
                mt={SPACING.lg}
              >
                {block.text}
              </Text>
            )

          case 'h3':
            return (
              <Text
                key={`h3-${block.text}`}
                as="h3"
                fontFamily="heading"
                fontSize={TYPOGRAPHY.h4}
                color={SEMANTIC_COLORS.textPrimary}
                mt={SPACING.base}
              >
                {block.text}
              </Text>
            )

          case 'hr':
            // Dividers are identical and the parse input is static — index key is fine.
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
                    {renderInline(item)}
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
                {renderInline(block.text)}
              </Text>
            )
        }
      })}
    </Box>
  )
}

export default BlogMarkdown
