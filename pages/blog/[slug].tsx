import React from 'react'
import type { GetServerSideProps } from 'next'
import Head from 'next/head'
import NextLink from 'next/link'
import { Box, Text, VStack, HStack } from '@chakra-ui/react'

import Seo from '@/components/Seo'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { BlogMarkdown, renderInline } from '@/components/Blog/BlogMarkdown'
import { getPost, type BlogPost } from '@/helpers/blog'

/**
 * /blog/[slug] — a single canonical post, server-rendered through <Seo> so
 * title/description/canonical and the full body are in the raw HTML (R1).
 *
 * The template enforces R13 by construction: the frontmatter drives a labeled
 * TL;DR box above the body and an FAQ section below it, so a post cannot ship
 * without LLM-parseable structure. FAQPage JSON-LD is emitted only when FAQ
 * items exist — DeFi is YMYL, and FAQPage is the only schema SEO_RULESET R8
 * allows beyond the landing page.
 *
 * getServerSideProps (not getStaticProps) for the pages/proto/[page].tsx
 * reason: static optimization + Next 15.5 dev isrManifest = HMR crash.
 */

type BlogPostProps = { post: BlogPost }

export const getServerSideProps: GetServerSideProps<BlogPostProps> = async ({ params, res }) => {
  const slug = typeof params?.slug === 'string' ? params.slug : ''
  const post = getPost(slug)
  if (!post) return { notFound: true }
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  return { props: { post } }
}

const faqJsonLd = (post: BlogPost) =>
  JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: post.faq.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  })

const BlogPostPage = ({ post }: BlogPostProps) => (
  <>
    <Seo title={post.title} description={post.description} path={`/blog/${post.slug}`} />
    {post.faq.length > 0 && (
      <Head>
        <script
          key="faq-jsonld"
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: faqJsonLd(post) }}
        />
      </Head>
    )}

    <Box maxW="820px" mx="auto" px={SPACING.base} py={SPACING['2xl']}>
      <VStack spacing={SPACING.lg} align="stretch" as="article">
        <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={SPACING.sm}>
          <Box as={NextLink} href="/blog">
            <Text
              fontFamily="mono"
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.28em"
              color={SEMANTIC_COLORS.primary}
            >
              ← Blog
            </Text>
          </Box>
          <Text fontFamily="mono" fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
            {post.date}
          </Text>
        </HStack>

        <Text as="h1" fontFamily="heading" fontSize={TYPOGRAPHY.h1} color={SEMANTIC_COLORS.textPrimary} lineHeight="1.2">
          {post.title}
        </Text>

        {post.tldr.length > 0 && (
          <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} p={SPACING.base}>
            <Text
              fontFamily="mono"
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.28em"
              color={SEMANTIC_COLORS.primary}
              mb={SPACING.sm}
            >
              TL;DR
            </Text>
            <Box as="ul" pl={SPACING.lg} display="grid" gap={SPACING.xs}>
              {post.tldr.map((item) => (
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
          </Box>
        )}

        <BlogMarkdown markdown={post.body} />

        {post.faq.length > 0 && (
          <>
            <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt={SPACING.lg} />
            <Text as="h2" fontFamily="heading" fontSize={TYPOGRAPHY.h3} color={SEMANTIC_COLORS.textPrimary}>
              FAQ
            </Text>
            <VStack spacing={SPACING.base} align="stretch">
              {post.faq.map(({ q, a }) => (
                <Box key={q}>
                  <Text as="h3" fontFamily="heading" fontSize={TYPOGRAPHY.h4} color={SEMANTIC_COLORS.textPrimary} mb={SPACING.xs}>
                    {q}
                  </Text>
                  <Text fontFamily="mono" fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} lineHeight="1.8">
                    {renderInline(a)}
                  </Text>
                </Box>
              ))}
            </VStack>
          </>
        )}
      </VStack>
    </Box>
  </>
)

export default BlogPostPage
