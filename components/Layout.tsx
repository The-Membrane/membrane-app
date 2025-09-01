import { Box, useDisclosure } from '@chakra-ui/react'
import HorizontalNav from './HorizontalNav'
import ChainLayout from './ChainLayout'
import { RulesModal } from './MembersRules/RulesModal'
import useMembersRulesState from './MembersRules/useRules'
import { useMemo } from 'react'
import RPCStatus from './RPCStatus'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {


  const { rulesState } = useMembersRulesState()
  const { isOpen, onOpen, onClose } = useDisclosure()


  useMemo(() => {
    if (!rulesState.show && rulesState.show !== undefined) {
      onClose()
    }
    if (rulesState.show) {
      onOpen()
    }
  }, [rulesState.show])
  return (
    <Box minH="100vh" bg="gray.900">
      <HorizontalNav />
      <ChainLayout>
        <Box as="main" justifyContent="center">
          <RPCStatus />
          {children}
        </Box>
      </ChainLayout>
      <RulesModal isOpen={isOpen} onClose={onClose} />
    </Box>
  )
}
