import React from 'react'
import dynamic from 'next/dynamic'
import { Skeleton } from '@chakra-ui/react'

/**
 * Defers recharts (~400KB parsed) to an on-demand, client-only chunk so it
 * stops slowing first paint on every page (next/dynamic, ssr:false — recharts
 * measures the DOM, so its SSR output is useless anyway).
 *
 * IMPORTANT: recharts 2.x identifies chart children (XAxis, Line, …) by
 * component identity, so individual exports must NOT be wrapped in dynamic()
 * one by one — that silently breaks axes/tooltips. Build the whole chart
 * subtree inside the factory instead, destructuring the real components from
 * the loaded module:
 *
 *   const MyChart = lazyChart<Props>(({ LineChart, Line, XAxis }) =>
 *     function MyChart({ data }) {
 *       return <LineChart data={data}>…</LineChart>
 *     })
 *
 * The factory runs once, when the recharts chunk finishes loading; the
 * component it returns behaves like any other (hooks are fine inside it).
 * For recharts types use RechartsModule — a static `import type … from
 * 'recharts'` still reads as an eager import to bundle linters.
 */
export type RechartsModule = typeof import('recharts')

export function lazyChart<P extends object>(
  build: (recharts: RechartsModule) => React.ComponentType<P>,
  loadingHeight: string | number = '200px',
) {
  return dynamic(async () => build(await import('recharts')), {
    ssr: false,
    loading: () => (
      <Skeleton
        height={loadingHeight}
        width="100%"
        borderRadius="md"
        startColor="whiteAlpha.100"
        endColor="whiteAlpha.300"
      />
    ),
  })
}
