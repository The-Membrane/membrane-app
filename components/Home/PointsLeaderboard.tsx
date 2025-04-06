import React from 'react';
import {
    Box,
    Heading,
    Table,
    Thead,
    Tbody,
    Tr,
    Th,
    Td,
    TableContainer,
    useColorModeValue,
} from '@chakra-ui/react';
import { useLeaderboardData } from '@/hooks/usePoints';

export type LeaderboardEntry = {
    rank: number;
    address: string;
    points: number;
    percentOfSupply: string;
    // [key: string]: any; // To allow extra data like 'earnedToday' or 'projectedPoints'
};

type Props = {
    data: LeaderboardEntry[] | undefined;
};

const PointsLeaderboard: React.FC<Props> = ({ data }) => {
    const bg = useColorModeValue('white', 'gray.800');
    const border = useColorModeValue('gray.200', 'gray.700');

    if (!data || data.length === 0) {
        return (
            <Box bg={bg} border="1px" borderColor={border} borderRadius="xl" p={6} boxShadow="md">
                <Heading size="md" mb={4}>
                    Points Leaderboard
                </Heading>
                <Box textAlign="center" color="gray.500">
                    No data available
                </Box>
            </Box>
        );
    }

    return (
        <Box bg={bg} border="1px" borderColor={border} borderRadius="xl" p={6} boxShadow="md">
            <Heading size="md" mb={4}>
                Points Leaderboard
            </Heading>
            <TableContainer>
                <Table variant="simple" size="sm">
                    <Thead>
                        <Tr>
                            <Th>Rank</Th>
                            <Th>Address</Th>
                            <Th isNumeric>Points</Th>
                            <Th isNumeric>% of Points Supply</Th>
                        </Tr>
                    </Thead>
                    <Tbody>
                        {data.map((entry) => (
                            <Tr key={entry.rank}>
                                <Td>{entry.rank}</Td>
                                <Td>{entry.address}</Td>
                                <Td isNumeric>{entry.points.toLocaleString()}</Td>
                                <Td isNumeric>{entry.percentOfSupply}</Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            </TableContainer>
        </Box>
    );
};

export default PointsLeaderboard;
