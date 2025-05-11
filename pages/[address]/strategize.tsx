import { useRouter } from 'next/router';
import { Box, Text } from '@chakra-ui/react';

const StrategizePage = () => {
    const router = useRouter();
    const { address } = router.query;

    return (
        <Box minH="100vh" display="flex" flexDirection="column" alignItems="center" justifyContent="center" bg="#181B23">
            <Text fontSize="2xl" color="white" fontWeight="bold">
                Strategize Placeholder
            </Text>
            <Text fontSize="lg" color="whiteAlpha.700" mt={4}>
                Address: {address}
            </Text>
            <Text fontSize="md" color="whiteAlpha.600" mt={2}>
                This is a placeholder for the Strategize action page.
            </Text>
        </Box>
    );
};

export default StrategizePage; 