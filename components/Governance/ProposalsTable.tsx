import usePagination, { Pagination as PaginationType } from '@/hooks/usePagination'
import { Box, HStack, Skeleton, Stack, Text } from '@chakra-ui/react'
import { Dispatch, SetStateAction, useState } from 'react'
import { Badge } from './Badge'
import { FilterButtons } from './FilterButtons'
import { Pagination } from './Pagination'
import ProposalDetails from './ProposalDetails'
import { Search } from './Search'
import { ProposalResponse } from '@/services/governance'
import { colors } from '@/config/defaults'
import { useProposals } from '@/hooks/useGovernance'

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
    <FilterButtons setFilter={setFilter} isSearch={!!search} />
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
      <Text fontSize="md" color={colors.noState}>
        No proposals fit this filter
      </Text>
    </Box>
  )
}

const EndsIn = ({ days, hours, minutes }: { days: number; hours: number; minutes: number }) => {
  if (!days && !hours && !minutes) return null
  if (days === 0 && hours === 0)
    return (
      <Text color={colors.noState} fontSize="sm">
        Ends in: {minutes} {minutes === 1 ? 'minute' : 'minutes'}
      </Text>
    )
  else if (days === 0)
    return (
      <Text color={colors.noState} fontSize="sm">
        Ends in: {hours} {hours === 1 ? 'hour' : 'hours'}
      </Text>
    )
  else
    return (
      <Text color={colors.noState} fontSize="sm">
        Ends in: {days} {days === 1 ? 'day' : 'days'}
      </Text>
    )
}

const Proposals = ({ proposals = [] }: { proposals: ProposalResponse[] }) => {
  if (proposals?.length === 0) return null
  return (
    <Stack>
      {proposals?.map((proposal) => (
        <ProposalDetails key={proposal.proposal_id} proposal={proposal}>
          <HStack px="4" py="3" bg="#191a2d" borderRadius="lg" gap="4">
            <Badge badge={proposal?.badge} />
            <Stack gap="0" m="none" p="none" flexGrow={1} alignItems="flex-start">
              <Text noOfLines={1}>{proposal.title}</Text>
              <EndsIn {...proposal?.daysLeft} />
            </Stack>
            <Text color="primary.200" fontSize="sm">
              {proposal?.status === 'active' ? 'Vote' : 'View'}
            </Text>
          </HStack>
        </ProposalDetails>
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
