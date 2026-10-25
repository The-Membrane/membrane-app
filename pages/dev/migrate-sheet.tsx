import React from 'react'
import dynamic from 'next/dynamic'
import type { GetServerSideProps } from 'next'

/**
 * DEV ONLY (404 in production). The body lives in components/Migrate/dev/DevMigrateSheet and is
 * loaded only when NODE_ENV is not production: the condition is a build-time constant, so webpack
 * drops the import — and with it the anvil test keys, the EIP-7702 dev batch path and the local
 * deployment file — from a production build.
 */
const DevMigrateSheet: React.ComponentType =
  process.env.NODE_ENV !== 'production' ? dynamic(() => import('@/components/Migrate/dev/DevMigrateSheet')) : () => null

export const getServerSideProps: GetServerSideProps = async () =>
  process.env.NODE_ENV === 'production' ? { notFound: true } : { props: {} }

export default DevMigrateSheet
