import React from 'react'
import type { GetServerSideProps } from 'next'
import NextLink from 'next/link'
import { Box, Text, VStack, HStack } from '@chakra-ui/react'

import Seo from '@/components/Seo'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { getAllPosts, type BlogPostMeta } from '@/helpers/blog'

/**
 * /blog — the canonical blog index (docs/SEO_RULESET.md "Blog placement":
 * canonical lives in-repo; Substack gets excerpts only).
 *
 * getServerSideProps rather than getStaticProps for the same reason as
 * pages/proto/[page].tsx: statically-optimized pages land in the dev
 * isrManifest and Next 15.5's hot-reloader crashes in handleStaticIndicator.
 * It also matches every other data-bearing page in this repo — nothing here
 * uses getStaticProps. Content is read server-side, so the full list is in
 * the raw HTML (R1).
 */

type BlogIndexProps = { posts: BlogPostMeta[] }

export const getServerSideProps: GetServerSideProps<BlogIndexProps> = async ({ res }) => {
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  const posts = getAllPosts().map(({ slug, title, description, date, tags, excerpt }) => ({
    slug, title, description, date, tags, excerpt,
  }))
  return { props: { posts } }
}

const BlogIndexPage = ({ posts }: BlogIndexProps) => (
  <>
    <Seo
      title="Membrane Blog — CDP borrowing, measured"
      description="Research and plain-English explainers on CDP stablecoins, liquidation mechanics, and DeFi carry — every number traced to a source. Measured, not promised."
      path="/blog"
    />

    <Box maxW="820px" mx="auto" px={SPACING.base} py={SPACING['2xl']}>
      <VStack spacing={SPACING.lg} align="stretch">
        <Text
          fontFamily="mono"
          fontSize={TYPOGRAPHY.label}
          textTransform="uppercase"
          letterSpacing="0.28em"
          color={SEMANTIC_COLORS.primary}
        >
          Blog
        </Text>

        <Text as="h1" fontFamily="heading" fontSize={TYPOGRAPHY.h1} color={SEMANTIC_COLORS.textPrimary}>
          Measured, not promised
        </Text>

        <Text fontFamily="mono" fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} lineHeight="1.8">
          Writing on CDP stablecoins, liquidation mechanics, and the economics of borrowing
          against crypto. Every number traces to a contract read, a dataset, or a measurement
          stamp — unflattering results included.
        </Text>

        <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} />

        {posts.length === 0 && (
          <Text fontFamily="mono" fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
            No posts yet.
          </Text>
        )}

        {posts.map((post) => (
          <Box
            key={post.slug}
            as="article"
            borderBottom="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            pb={SPACING.lg}
          >
            <VStack spacing={SPACING.sm} align="stretch">
              <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={SPACING.sm}>
                <Text fontFamily="mono" fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                  {post.date}
                </Text>
                {post.tags.length > 0 && (
                  <Text
                    fontFamily="mono"
                    fontSize={TYPOGRAPHY.xs}
                    textTransform="uppercase"
                    letterSpacing="0.12em"
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    {post.tags.join(' · ')}
                  </Text>
                )}
              </HStack>

              <Box
                as={NextLink}
                href={`/blog/${post.slug}`}
                _hover={{ textDecoration: 'underline', textUnderlineOffset: '4px' }}
              >
                <Text as="h2" fontFamily="heading" fontSize={TYPOGRAPHY.h2} color={SEMANTIC_COLORS.textPrimary}>
                  {post.title}
                </Text>
              </Box>

              <Text fontFamily="mono" fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} lineHeight="1.7">
                {post.description}
              </Text>

              <Box as={NextLink} href={`/blog/${post.slug}`} alignSelf="flex-start">
                <Text
                  fontFamily="mono"
                  fontSize={TYPOGRAPHY.xs}
                  textTransform="uppercase"
                  letterSpacing="0.18em"
                  color={SEMANTIC_COLORS.primary}
                >
                  Read →
                </Text>
              </Box>
            </VStack>
          </Box>
        ))}
      </VStack>
    </Box>
  </>
)

export default BlogIndexPage
