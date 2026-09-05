import dynamic from 'next/dynamic'
import { Box, Skeleton, VStack } from '@chakra-ui/react'
import PageSeo from '@/components/PageSeo'

// ssr:false is load-bearing: services/membraneDashboardMockData builds its series with
// Math.random() at module scope, so a server-rendered pass would never match the client
// and React would blow the whole tree away on hydration.
//
// The `loading` fallback is NOT cosmetic. Without it next/dynamic renders literally
// `null` until the chunk resolves — and if the chunk ever fails to resolve, the route
// is indistinguishable from a working page with an empty body (nav bar renders, main is
// blank, nothing in the console). Every other lazy surface in this app ships a Skeleton
// (see components/ui/lazyChart.tsx); this page was the one that didn't.
const MembraneDashboard = dynamic(
  () => import('@/components/MembraneDashboard/MembraneDashboard'),
  {
    ssr: false,
    loading: () => (
      <Box w="100%" maxW="1400px" mx="auto" p={{ base: 4, md: 8 }} pt={{ base: 24, md: 28 }}>
        <VStack spacing={4} align="stretch">
          <Skeleton h="48px" />
          <Skeleton h="96px" />
          <Skeleton h="340px" />
        </VStack>
      </Box>
    ),
  }
)

const MembraneDashboardPage = () => (
  <>
    {/* Rule 0 (docs/SEO_RULESET.md): internal — mock-data protocol metrics dashboard */}
    <PageSeo
      seoClass="internal"
      title="Membrane — Protocol Dashboard"
      description="Client-only dashboard charting protocol revenue history, interest rate history, and the liquidation funnel, built with page-specific mock data for now."
    />
    <MembraneDashboard />
  </>
)

export default MembraneDashboardPage
