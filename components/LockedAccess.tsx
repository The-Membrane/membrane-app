import { Card, CardFooter, CardHeader, Stack, Text } from '@chakra-ui/react'
import Page from './Page'
import { ConnectButton } from './WallectConnect'

const LockedAccess = () => {
  return (
    <Page isScrollable={false}>
      <Stack w="420px" h="full" justifyContent="center">
        <Card>
          <CardHeader>
            <Text variant="title" fontSize="24px">
              Access Pending
            </Text>
            <Text color="white" fontSize="xs" fontWeight="normal">
              Connect you wallet to access.
            </Text>
          </CardHeader>
          <CardFooter>
            <ConnectButton />
          </CardFooter>
        </Card>
      </Stack>
    </Page>
  )
}

export default LockedAccess
