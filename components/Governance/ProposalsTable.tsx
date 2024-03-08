import usePagination, { Pagination as PaginationType } from '@/hooks/usePagination'
import { Box, HStack, Skeleton, Stack, Text } from '@chakra-ui/react'
import { Dispatch, SetStateAction, useState } from 'react'
import { Badge } from './Badge'
import { FilterButtons } from './FilterButtons'
import { Pagination } from './Pagination'
import ProposalDetails from './ProposalDetails'
import useProposals from './hooks/useProposals'
import { Search } from './Search'
import { ProposalResponse } from '@/services/governance'

export type Filter = {
  status: string
}

type TopBarProps = {
  setFilter: Dispatch<SetStateAction<Filter>>
  setSearch: Dispatch<SetStateAction<string>>
  search: string
}

const TopBar = ({ setFilter, setSearch, search }: TopBarProps) => (
  <HStack w="100%" justifyContent="space-between">
    <FilterButtons setFilter={setFilter} />
    <Search search={search} setSearch={setSearch} />
  </HStack>
)

const Loading = () => (
  <Stack w="636px">
    <Skeleton w="full" h="50px" borderRadius="md" />
    <Skeleton w="full" h="50px" borderRadius="md" />
    <Skeleton w="full" h="50px" borderRadius="md" />
  </Stack>
)

const NoProposals = ({ show }: { show: boolean }) => {
  if (!show) return null
  return (
    <Box p="3" bg="whiteAlpha.200" borderRadius="lg" textAlign="center">
      <Text fontSize="md" color="gray.300">
        No active proposals
      </Text>
    </Box>
  )
}

const Proposals = ({ proposals = [] }: { proposals: ProposalResponse[] }) => {
  if (proposals?.length === 0) return null
  return (
    <Stack>
      {proposals?.map((proposal) => (
        <HStack
          key={proposal.proposal_id}
          px="5"
          py="2"
          bg="whiteAlpha.200"
          borderRadius="lg"
          gap="4"
        >
          <Badge badge={proposal?.badge} />
          <Stack gap="0" m="none" p="none" flexGrow={1}>
            <Text noOfLines={1}>{proposal.title}</Text>
            <Text color="gray" fontSize="sm" noOfLines={1}>
              days remaining: {proposal.end_block}
            </Text>
          </Stack>
          <ProposalDetails proposal={proposal} />
        </HStack>
      ))}
    </Stack>
  )
}

type PaginationProps = {
  pagination: Omit<PaginationType<ProposalResponse>, 'paginatedData'>
}

const PaginationBar = ({ pagination }: PaginationProps) => {
  if (pagination.totalPages <= 1) return null
  return (
    <HStack w="100%" justifyContent="flex-end">
      <Pagination {...pagination} />
    </HStack>
  )
}

const ProposalsTable = () => {
  const [filters, setFilters] = useState<Filter>({ status: 'active' })
  const [search, setSearch] = useState<string>('')
  const { data = [], isLoading } = useProposals()
  const { paginatedData, ...pagination } = usePagination(data, 10, filters, search)

  if (isLoading) {
    return <Loading />
  }

  return (
    <Stack w="full" gap="5">
      <TopBar setFilter={setFilters} search={search} setSearch={setSearch} />
      <NoProposals show={paginatedData.length === 0} />
      <Proposals proposals={paginatedData} />
      <PaginationBar pagination={pagination} />
    </Stack>
  )
}

export default ProposalsTable
