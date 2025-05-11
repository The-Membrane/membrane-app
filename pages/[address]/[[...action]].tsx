import { useRouter } from 'next/router';
import { Box, Text } from '@chakra-ui/react';

const AddressActionPage = () => {
    const router = useRouter();
    const { address, action } = router.query;

    // action will be an array or undefined
    const actionType = Array.isArray(action) && action.length > 0 ? action[0] : 'multiply'; // default to multiply

    return (
        <Box minH="100vh" display="flex" flexDirection="column" alignItems="center" justifyContent="center" bg="#181B23">
            <Text fontSize="2xl" color="white" fontWeight="bold">
                {actionType.charAt(0).toUpperCase() + actionType.slice(1)} Placeholder
            </Text>
            <Text fontSize="lg" color="whiteAlpha.700" mt={4}>
                Address: {address}
            </Text>
            <Text fontSize="md" color="whiteAlpha.600" mt={2}>
                This is a placeholder for the {actionType} action page.
            </Text>
        </Box>
    );
};

export default AddressActionPage; 