import { PageTutorialConfig } from '@/components/DittoSpeechBox/hooks/usePageTutorial'

export const discoTutorialConfig: PageTutorialConfig = {
    pageId: 'Disco',
    steps: [
        {
            id: 'welcome',
            title: 'Welcome to Disco!',
            content: 'Disco is the LTV Discovery protocol. Join the guardians of solvency and get paid CDT for assisting LTV discovery and absorbing bad debt first. This tutorial will guide you through the key features.',
            position: 'center',
        },
        {
            id: 'ltv-discovery',
            title: 'LTV Discovery',
            content: 'The hex graphic visualizes the LTV (Loan-to-Value) discovery system. Each hexagon represents different LTV levels where users can deposit. The color opacity indicates the total value locked at each LTV level. Hover them to see more info.',
            position: 'right',
        },
        {
            id: 'liquidation-ltv',
            title: 'Liquidation LTV',
            content: 'The Liquidation LTV carousel shows different liquidation thresholds. When the collateral value drops below this LTV, positions can be liquidated. Higher LTV means higher risk but potentially higher yield.',
            position: 'left',
        },
        {
            id: 'borrow-ltv',
            title: 'Borrow LTV',
            content: 'The Borrow LTV carousel shows the maximum LTV you can borrow against your collateral. This determines how much you can leverage your position. Select different LTV pairs to see available options.',
            position: 'left',
        },
        {
            id: 'metrics',
            title: 'Metrics & Analytics',
            content: 'The metrics section shows global statistics including total TVL, average LTV, yield ranges, and insurance coverage. Use the charts to track historical performance and trends.',
            position: 'top',
        },
        {
            id: 'faq',
            title: 'Need More Help?',
            content: 'Check out the FAQ section for answers to common questions about Disco, LTV discovery, liquidation mechanics, and more. You can access it anytime from the tutorial or Ditto hub.',
            position: 'center',
        },
    ],
    faq: [
        {
            id: 'what-is-disco',
            question: 'What is Disco and LTV Discovery?',
            answer: 'Disco is the LTV Discovery protocol that allows users to deposit collateral at different LTV (Loan-to-Value) levels. The protocol discovers optimal LTV ratios through market dynamics, and users who participate in discovery and absorb bad debt first are rewarded with CDT tokens.',
        },
        {
            id: 'how-liquidation-works',
            question: 'How does liquidation work?',
            answer: 'When the value of your collateral drops below the liquidation LTV threshold, your position can be liquidated. Liquidators can claim a portion of your collateral as a reward. Higher liquidation LTV means positions are liquidated earlier, which provides more protection but may reduce potential yield.',
        },
        {
            id: 'what-are-risks',
            question: 'What are the risks?',
            answer: 'The main risks include liquidation if collateral value drops below the liquidation LTV, smart contract risks, and market volatility. Higher LTV positions offer higher potential yield but come with increased liquidation risk. Always understand the risks before depositing.',
        },
        {
            id: 'how-to-deposit',
            question: 'How do I deposit?',
            answer: 'Select your desired LTV pair (liquidation LTV and borrow LTV) using the carousels. Click on a deposit form (usually accessible through Ditto or the page interface) and specify the amount you want to deposit. Your deposit will be allocated to the selected LTV tranche.',
        },
        {
            id: 'how-to-withdraw',
            question: 'How do I withdraw?',
            answer: 'You can withdraw your deposits at any time, subject to the terms of your specific deposit. Some deposits may have lock periods. Use the withdraw form accessible through Ditto or the page interface to initiate a withdrawal.',
        },
        {
            id: 'yield-calculation',
            question: 'How is yield calculated?',
            answer: 'Yield is generated from various sources including protocol revenue, liquidation fees, and other mechanisms. The yield range shown represents the estimated annual percentage rate (APR) based on historical performance. Actual yields may vary based on market conditions.',
        },
        {
            id: 'what-is-insurance',
            question: 'What is the insurance system?',
            answer: 'The insurance system provides protection against bad debt. Users who deposit at certain LTV levels act as insurance providers and are compensated for taking on this risk. The total insurance value represents the amount of coverage available in the system.',
        },
    ],
}


