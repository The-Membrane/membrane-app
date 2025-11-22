import { Box, useDisclosure } from '@chakra-ui/react'
import HorizontalNav from './HorizontalNav'
import ChainLayout from './ChainLayout'
import { RulesModal } from './MembersRules/RulesModal'
import useMembersRulesState from './MembersRules/useRules'
import { useMemo, useEffect } from 'react'
import RPCStatus from './RPCStatus'
import { useRouter } from 'next/router'
import { DittoHologram } from './DittoHologram'
import useAppState from '@/persisted-state/useAppState'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const router = useRouter()
  // const { rulesState } = useMembersRulesState()
  // const { isOpen, onOpen, onClose } = useDisclosure()

  // Check if we're on the home page
  const isHomePage = (router.pathname === '/[chain]' || router.pathname === '/[chain]/index') && (!router.query.view || router.query.view === 'storefront')

  const { appState } = useAppState()
  const username = appState.setCookie && appState.username ? appState.username : ''

  // Set body/html background to match the page background on home page
  useEffect(() => {
    const styleId = 'home-page-bg'

    const applyStyle = () => {
      let styleElement = document.getElementById(styleId) as HTMLStyleElement

      if (isHomePage) {
        if (!styleElement) {
          styleElement = document.createElement('style')
          styleElement.id = styleId
          // Append at the end of head to ensure it overrides other styles
          document.head.appendChild(styleElement)
        }
        styleElement.textContent = `
          html, body, #__next {
            background-color: #0A0A0A !important;
            background: #0A0A0A !important;
          }
        `
      } else {
        const element = document.getElementById(styleId)
        if (element) {
          element.remove()
        }
      }
    }

    // Apply using requestAnimationFrame to ensure it runs after Chakra styles
    const rafId = requestAnimationFrame(() => {
      applyStyle()
      // Also apply again after a frame to be sure
      requestAnimationFrame(applyStyle)
    })

    return () => {
      cancelAnimationFrame(rafId)
      const element = document.getElementById(styleId)
      if (element) {
        element.remove()
      }
    }
  }, [isHomePage])

  // useMemo(() => {
  //   if (!rulesState.show && rulesState.show !== undefined) {
  //     onClose()
  //   }
  //   if (rulesState.show) {
  //     onOpen()
  //   }
  // }, [rulesState.show])

  return (
    <Box minH="100vh" bg={isHomePage ? "#0A0A0A" : "gray.900"}>
      <HorizontalNav />
      <ChainLayout>
        <Box as="main" justifyContent="center">
          <RPCStatus />
          {children}
        </Box>
      </ChainLayout>
      {/* <RulesModal isOpen={isOpen} onClose={onClose} /> */}
      <DittoHologram stayShown={!!username.trim()} />
    </Box>
  )
}
