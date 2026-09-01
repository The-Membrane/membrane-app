import { loadEnvConfig } from '@next/env'
import type { Config } from 'drizzle-kit'

// drizzle-kit only auto-loads .env, but this repo keeps secrets in .env.local
// (Next.js convention, pulled via `vercel env pull`) — so load through Next's own
// env loader. Migrations prefer DATABASE_URL_UNPOOLED — the Neon Vercel
// integration provides it for direct (non-pooled) connections, which drizzle-kit
// needs for DDL. Falls back to DATABASE_URL for local/dev setups that only have that.
loadEnvConfig(process.cwd())

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '',
  },
} satisfies Config
