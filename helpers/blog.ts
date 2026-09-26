import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

/**
 * Server-side loader for the in-repo blog (docs/SEO_RULESET.md, "Blog placement":
 * the canonical blog lives at /blog; Substack only ever gets the excerpt).
 *
 * Posts are markdown files in content/blog/*.mdx with YAML frontmatter. The
 * filename is the slug — the frontmatter `slug` field exists so the file is
 * self-describing when read outside the app, but the filename wins on conflict.
 *
 * Only import this from getServerSideProps (it uses fs); Next strips it from
 * the client bundle as long as no component code touches it.
 */

const BLOG_DIR = path.join(process.cwd(), 'content', 'blog')

/** Frontmatter-driven FAQ entry — rendered as an R13 FAQ section + FAQPage JSON-LD. */
export type BlogFaq = { q: string; a: string }

export type BlogPostMeta = {
  slug: string
  title: string
  description: string
  /** ISO date (YYYY-MM-DD). */
  date: string
  tags: string[]
  /** The Substack-bound excerpt; also shown on the index page. */
  excerpt: string
}

export type BlogPost = BlogPostMeta & {
  /** TL;DR bullets rendered in the labeled box above the body (R13). */
  tldr: string[]
  faq: BlogFaq[]
  /** Raw markdown body (frontmatter removed). */
  body: string
}

/** Slugs come from URLs — never let one escape content/blog. */
const isSafeSlug = (slug: string) => /^[a-z0-9][a-z0-9-]*$/.test(slug)

export const getPostSlugs = (): string[] => {
  if (!fs.existsSync(BLOG_DIR)) return []
  return fs
    .readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith('.mdx') || file.endsWith('.md'))
    .map((file) => file.replace(/\.mdx?$/, ''))
    .filter(isSafeSlug)
    .sort()
}

export const getPost = (slug: string): BlogPost | null => {
  if (!isSafeSlug(slug)) return null
  const file = ['.mdx', '.md']
    .map((ext) => path.join(BLOG_DIR, `${slug}${ext}`))
    .find(fs.existsSync)
  if (!file) return null

  const { data, content } = matter(fs.readFileSync(file, 'utf8'))
  return {
    slug,
    title: String(data.title ?? slug),
    description: String(data.description ?? ''),
    date: String(data.date ?? ''),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    excerpt: String(data.excerpt ?? ''),
    tldr: Array.isArray(data.tldr) ? data.tldr.map(String) : [],
    faq: Array.isArray(data.faq)
      ? data.faq
          .filter((item): item is { q: unknown; a: unknown } => Boolean(item && item.q && item.a))
          .map((item) => ({ q: String(item.q), a: String(item.a) }))
      : [],
    body: content.trim(),
  }
}

/** All posts, newest first — the index page and sitemap both read this. */
export const getAllPosts = (): BlogPost[] =>
  getPostSlugs()
    .map(getPost)
    .filter((post): post is BlogPost => post !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
