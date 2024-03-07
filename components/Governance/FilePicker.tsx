import { FormControl, FormLabel, HStack, Button, FormErrorMessage, Text } from '@chakra-ui/react'
import React from 'react'

type Props = {
  filesContent: any
  openFilePicker: () => void
  errors: any
}

const SelectFile = ({ openFilePicker }: { openFilePicker: () => void }) => {
  return (
    <Button
      type="button"
      onClick={openFilePicker}
      bg="whiteAlpha.300"
      color="blck"
      boxShadow="none"
      fontSize="sm"
      w="fit-content"
      px="10"
      _hover={{
        bg: 'whiteAlpha.400',
      }}
    >
      Select file
    </Button>
  )
}

const SelectedFile = ({
  filesContent,
  openFilePicker,
}: {
  filesContent: any
  openFilePicker: () => void
}) => {
  return (
    <HStack>
      <Text>{filesContent[0].name}</Text>
      <Button
        type="button"
        onClick={openFilePicker}
        variant="ghost"
        boxShadow="none"
        fontSize="sm"
        w="fit-content"
      >
        Change file
      </Button>
    </HStack>
  )
}

const FilePicker = ({ filesContent, openFilePicker, errors }: Props) => {
  return (
    <FormControl isInvalid={!!errors?.msgs}>
      <FormLabel htmlFor="msgs">Msgs</FormLabel>

      {filesContent.length > 0 ? (
        <SelectedFile filesContent={filesContent} openFilePicker={openFilePicker} />
      ) : (
        <SelectFile openFilePicker={openFilePicker} />
      )}

      <FormErrorMessage>{errors?.msgs && errors?.msgs?.message}</FormErrorMessage>
    </FormControl>
  )
}

export default FilePicker
