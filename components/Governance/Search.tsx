import { CloseIcon, Search2Icon } from '@chakra-ui/icons'
import { IconButton, Input, InputGroup, InputRightElement } from '@chakra-ui/react'
import { ChangeEvent } from 'react'

type Props = {
  search: string
  setSearch: (value: string) => void
}

export const Search = ({ search, setSearch }: Props) => {
  const onChange = (e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)
  return (
    <InputGroup w="300px">
      <Input
        type="text"
        fontSize="sm"
        placeholder="Search"
        value={search}
        h="8"
        textAlign="left"
        onChange={onChange}
      />
      <InputRightElement>
        {!!search ? (
          <IconButton
            aria-label="clear search"
            icon={<CloseIcon color="primary.200" boxSize="2.5" mb="2" cursor="pointer" />}
            variant="unstyled"
            onClick={() => setSearch('')}
          />
        ) : (
          <Search2Icon color="gray.500" boxSize="4" mb="2" />
        )}
      </InputRightElement>
    </InputGroup>
  )
}
