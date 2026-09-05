import React from 'react';
import { Box } from '@chakra-ui/react';
import { PortPage } from '@/components/Portfolio/PortPage';
import PageSeo from '@/components/PageSeo';

const PortfolioPage = () => (
  <Box minH="100vh" bg="none">
    {/* Rule 0 (docs/SEO_RULESET.md): app — wallet-gated portfolio dashboard */}
    <PageSeo
      seoClass="app"
      title="Membrane — Portfolio"
      description="View your wallet's Membrane portfolio: revenue earned over time, boost level, points progress, contribution history, and any active reward or airdrop events."
    />
    <PortPage />
  </Box>
);

export default PortfolioPage; 