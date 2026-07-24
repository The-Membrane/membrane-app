import React from 'react'
import { HStack, Button } from '@chakra-ui/react'
import { UpdateFilter } from '../hooks/useProtocolUpdates'

interface UpdatesFilterTabsProps {
    filter: UpdateFilter
    setFilter: (filter: UpdateFilter) => void
}

export const UpdatesFilterTabs: React.FC<UpdatesFilterTabsProps> = ({ filter, setFilter }) => {
    return (
        <HStack
            spacing={2}
            overflowX="auto"
            overflowY="hidden"
            pb={2}
            w="100%"
            align="flex-start"
            css={{
                '&::-webkit-scrollbar': {
                    height: '4px',
                },
                '&::-webkit-scrollbar-track': {
                    background: 'transparent',
                },
                '&::-webkit-scrollbar-thumb': {
                    background: '#9bdc4f40',
                    borderRadius: '2px',
                },
            }}
        >
            <Button
                size="sm"
                variant={filter === 'all' ? 'solid' : 'ghost'}
                bg={filter === 'all' ? '#9bdc4f' : 'transparent'}
                color={filter === 'all' ? 'white' : '#ece6d880'}
                border={filter === 'all' ? 'none' : '1px solid'}
                borderColor={filter === 'all' ? 'transparent' : '#9bdc4f30'}
                borderRadius="full"
                px={4}
                py={1.5}
                fontSize="xs"
                fontWeight={filter === 'all' ? 'semibold' : 'normal'}
                _hover={{
                    bg: filter === 'all' ? '#9bdc4f' : '#9bdc4f20',
                    borderColor: filter === 'all' ? 'transparent' : '#9bdc4f50',
                    color: filter === 'all' ? 'white' : '#ece6d8'
                }}
                onClick={() => setFilter('all')}
                whiteSpace="nowrap"
                flexShrink={0}
                w="50%"
            >
                All
            </Button>
            <Button
                size="sm"
                variant={filter === 'unread' ? 'solid' : 'ghost'}
                bg={filter === 'unread' ? '#9bdc4f' : 'transparent'}
                color={filter === 'unread' ? 'white' : '#ece6d880'}
                border={filter === 'unread' ? 'none' : '1px solid'}
                borderColor={filter === 'unread' ? 'transparent' : '#9bdc4f30'}
                borderRadius="full"
                px={4}
                py={1.5}
                fontSize="xs"
                fontWeight={filter === 'unread' ? 'semibold' : 'normal'}
                _hover={{
                    bg: filter === 'unread' ? '#9bdc4f' : '#9bdc4f20',
                    borderColor: filter === 'unread' ? 'transparent' : '#9bdc4f50',
                    color: filter === 'unread' ? 'white' : '#ece6d8'
                }}
                onClick={() => setFilter('unread')}
                whiteSpace="nowrap"
                flexShrink={0}
                w="50%"
            >
                Unread
            </Button>
        </HStack>
    )
}
