import React from 'react';
import Portfolio from '@/components/Portfolio/Portfolio';
import { Box } from '@chakra-ui/react';
import { PortPage } from '@/components/Portfolio/PortPage';

const PortfolioPage = () => (
  <Box minH="100vh" bg="none">
    {/* <Portfolio /> */}
    <PortPage />
  </Box>
);

export default PortfolioPage; 