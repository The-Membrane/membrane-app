import { Center } from '@chakra-ui/react'
import useMembersRulesState from './useRules'
import { RulesModal } from './RulesModal'


const MembersRules = () => {
  const { rulesState } = useMembersRulesState()
  if (rulesState.show === false && rulesState.show != undefined) return null
  return (
    <Center
      style={{ zoom: "100%" }}
      w="1440px"
      h="1080px"
      margin="auto"
      bg="#111015"
      position="relative"
      zIndex={1}
      bgImg={`url("/images/backgrounds/rules_bg.svg")`}
      bgSize="contain"
      bgRepeat="no-repeat"
      bgPosition="center"
    >
      <RulesModal />
    </Center>
  )
}

export default MembersRules
