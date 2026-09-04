import { Box, useDisclosure } from '@chakra-ui/react'
import HorizontalNav from './HorizontalNav'
import ChainLayout from './ChainLayout'
import { RulesModal } from './MembersRules/RulesModal'
import useMembersRulesState from './MembersRules/useRules'
import RPCStatus from './RPCStatus'
import { useRouter } from 'next/router'
import dynamic from 'next/dynamic'
import useAppState from '@/persisted-state/useAppState'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { DailyFirstTicker } from '@/components/Ticker/DailyFirstTicker'

// Lazy load DittoHologram since it's conditionally rendered and contains heavy dependencies
const DittoHologram = dynamic(
  () => import('./DittoHologram').then((m) => ({ default: m.DittoHologram })),
  {
    ssr: false,
  },
)

interface LayoutProps {
  children: React.ReactNode
}

// Ditto renders ONLY on executable pages (owner ruling 2026-09-04: no mascot
// chrome on decision-tool/read-only surfaces — it reads as an eyesore next to
// numbers). Executable = a live contract action exists on the page. Full
// mobile removal is a separate open question with the Membrane: App session.
const EXECUTABLE_ROUTES = [
  '/mint',
  '/disco',
  '/transmuter',
  '/stake',
  '/manic',
  '/portfolio',
  '/earn',
  '/liquidate',
  '/lockdrop',
  '/borrow',
  '/position',
  '/boost',
  '/isolated',
]

const isExecutableRoute = (pathname: string): boolean =>
  EXECUTABLE_ROUTES.some((r) => pathname.includes(r))

export default function Layout({ children }: LayoutProps) {
  const router = useRouter()
  // const { rulesState } = useMembersRulesState()
  // const { isOpen, onOpen, onClose } = useDisclosure()

  const { appState } = useAppState()
  const username = appState.setCookie && appState.username ? appState.username : ''

  // The page background used to be an allowlist: Home and Disco got a hardcoded
  // #0A0A0A, injected as an !important <style> tag on every render, and every
  // other route fell through to Chakra's gray.900 — which is #171923, a navy.
  // Since the whole app is Living Typeface (bone on near-black), the allowlist,
  // the raw hex and the runtime style injection are all gone; the background now
  // comes from SEMANTIC_COLORS.bgPrimary alone, matching the theme's html/body.

  // useMemo(() => {
  //   if (!rulesState.show && rulesState.show !== undefined) {
  //     onClose()
  //   }
  //   if (rulesState.show) {
  //     onOpen()
  //   }
  // }, [rulesState.show])

  return (
    <Box minH="100vh" bg={SEMANTIC_COLORS.bgPrimary}>
      <HorizontalNav />
      <DailyFirstTicker />
      <ChainLayout>
        <Box as="main" justifyContent="center" pb={{ base: '200px', md: '180px', lg: '180px' }}>
          <RPCStatus />
          {children}
        </Box>
      </ChainLayout>
      {/* <RulesModal isOpen={isOpen} onClose={onClose} /> */}
      {isExecutableRoute(router.pathname) && <DittoHologram stayShown={true} />}
    </Box>
  )
}
