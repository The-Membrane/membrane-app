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
    Link,
} from '@chakra-ui/react';
import { useLeaderboardData } from '@/hooks/usePoints';
import { colors } from '@/config/defaults';
import useWallet from '@/hooks/useWallet';

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
    const { address } = useWallet();

    if (!data || data.length === 0) {
        return (
            <Box bg={bg} border="1px" borderColor={border} borderRadius="xl" p={6} boxShadow="md" mt={"10%"}>
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
        <Box bg={bg} border="1px" borderColor={border} borderRadius="xl" p={6} boxShadow="md" mt={"10%"}>
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
                                <Td color={entry.address === address ? colors.tabBG : undefined}>{entry.rank}</Td>
                                <Td color={entry.address === address ? colors.tabBG : undefined}>
                                    <Link href={`https://celatone.io/osmosis/accounts/${entry.address}`} isExternal>
                                        {`${entry.address.substring(0, 5)}...${entry.address.substring(entry.address.length - 5)}`}
                                    </Link>
                                </Td>
                                <Td isNumeric color={entry.address === address ? colors.tabBG : undefined}>{entry.points.toLocaleString()}</Td>
                                <Td isNumeric color={entry.address === address ? colors.tabBG : undefined}>{entry.percentOfSupply}</Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            </TableContainer>
        </Box>
    );
};

export default PointsLeaderboard;
