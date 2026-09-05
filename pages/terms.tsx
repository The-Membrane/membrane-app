import React from 'react'
import { Box, Text, VStack, HStack, Spinner } from '@chakra-ui/react'
import PageSeo from '@/components/PageSeo'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { TermsContent, termsVersion } from '@/components/Terms/TermsContent'

/**
 * /terms — the canonical, linkable Terms of Service page.
 *
 * This route is load-bearing beyond being a footer link: the borrow flow asks the
 * user to sign an intent whose message names the document and its version, so the
 * URL in that signature has to resolve to something real and stable.
 *
 * Source of truth is `public/TOS.md`, the same file StorefrontTOSModal fetches —
 * one document, two surfaces, no drifting copies.
 */
const TermsPage = () => {
  const [markdown, setMarkdown] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    let live = true
    fetch('/TOS.md')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      })
      .then((text) => { if (live) setMarkdown(text) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [])

  const version = markdown ? termsVersion(markdown) : null

  return (
    <>
      {/* Rule 0 (docs/SEO_RULESET.md): indexable — canonical, linkable Terms of Service page */}
      <PageSeo
        seoClass="indexable"
        title="Membrane — Terms of Service"
        description="The Terms of Service governing use of the Membrane protocol and app, including the version referenced by borrow-flow intent signatures."
        path="/terms"
      />

      <Box maxW="820px" mx="auto" px={SPACING.base} py={SPACING['2xl']}>
        <VStack spacing={SPACING.lg} align="stretch">
          {/* The version is surfaced because signatures reference it by name. */}
          <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={SPACING.sm}>
            <Text
              fontFamily="mono"
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.28em"
              color={SEMANTIC_COLORS.primary}
            >
              Terms of Service
            </Text>
            {version && (
              <Text
                fontFamily="mono"
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                Version {version}
              </Text>
            )}
          </HStack>

          <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} />

          {failed && (
            <Text
              fontFamily="mono"
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.danger}
            >
              The terms could not be loaded. Reload the page, or read them directly at{' '}
              <Box as="a" href="/TOS.md" color={SEMANTIC_COLORS.primary} textDecoration="underline">
                /TOS.md
              </Box>
              .
            </Text>
          )}

          {!markdown && !failed && (
            <HStack spacing={SPACING.md} color={SEMANTIC_COLORS.textSecondary}>
              <Spinner size="sm" speed="0.8s" color={SEMANTIC_COLORS.primary} />
              <Text fontFamily="mono" fontSize={TYPOGRAPHY.small}>
                Loading terms…
              </Text>
            </HStack>
          )}

          {markdown && <TermsContent markdown={markdown} />}
        </VStack>
      </Box>
    </>
  )
}

export default TermsPage
