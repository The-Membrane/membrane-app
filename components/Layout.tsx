import { Box } from '@chakra-ui/react'
import HorizontalNav from './HorizontalNav'
import ChainLayout from './ChainLayout'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  return (
    <Box minH="100vh" bg="gray.900">
      <HorizontalNav />
      <ChainLayout>
        <Box as="main" p={4} justifyContent="center">
          {children}
        </Box>
      </ChainLayout>
    </Box>
  )
}
