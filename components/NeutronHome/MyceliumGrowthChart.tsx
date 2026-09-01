import React from 'react';
import { Box, Text, VStack } from '@chakra-ui/react';
import { lazyChart } from '@/components/ui/lazyChart';

// Chart data calculation for 10-year compound growth
export interface ChartDataPoint {
    year: number;
    baseAmount: number;
    boostedAmount: number;
}

const formatTooltipValue = (value: number) => {
    return value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
};

const CompoundGrowthChart = lazyChart<{ chartData: ChartDataPoint[]; symbol: string }>(
    ({ LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip: RechartsTooltip }) =>
        function CompoundGrowthChart({ chartData, symbol }) {
            return (
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                        <XAxis
                            dataKey="year"
                            tick={{ fontSize: 12, fill: '#9CA3AF' }}
                            axisLine={{ stroke: '#374151' }}
                            tickLine={{ stroke: '#374151' }}
                            label={{ value: 'Year', position: 'insideBottom', offset: -10, style: { textAnchor: 'middle', fill: '#9CA3AF', fontSize: '12px' } }}
                        />
                        <YAxis
                            tick={{ fontSize: 12, fill: '#9CA3AF' }}
                            axisLine={{ stroke: '#374151' }}
                            tickLine={{ stroke: '#374151' }}
                            label={{ value: symbol, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: '#9CA3AF', fontSize: '12px' } }}
                            tickFormatter={(value) => {
                                if (value >= 1000) {
                                    return `${(value / 1000).toFixed(1)}K`;
                                }
                                return value.toFixed(0);
                            }}
                        />
                        <RechartsTooltip
                            contentStyle={{
                                backgroundColor: '#1f2937',
                                border: '1px solid #374151',
                                borderRadius: '8px',
                                color: 'white'
                            }}
                            labelStyle={{ color: 'white' }}
                            formatter={(value: any, name: string, props: any) => {
                                const dataKey = props.dataKey;
                                const label = dataKey === 'baseAmount' ? 'Base APR (10%)' : 'Boosted APR (15%)';
                                return [`${formatTooltipValue(value)} tokens`, label];
                            }}
                            labelFormatter={(label) => `Year ${label}`}
                        />
                        <Line
                            type="monotone"
                            dataKey="baseAmount"
                            stroke="#9CA3AF"
                            strokeWidth={2}
                            dot={false}
                            name="Base APR (10%)"
                        />
                        <Line
                            type="monotone"
                            dataKey="boostedAmount"
                            stroke="#3b82f6"
                            strokeWidth={3}
                            dot={false}
                            name="Boosted APR (15%)"
                        />
                    </LineChart>
                </ResponsiveContainer>
            );
        },
    '200px',
);

interface MyceliumGrowthChartProps {
    chartData: ChartDataPoint[];
    symbol: string;
}

const MyceliumGrowthChart: React.FC<MyceliumGrowthChartProps> = ({ chartData, symbol }) => {
    return (
        <Box w="100%" maxW="700px" mt={8} mb={4}>
            <VStack spacing={4} w="100%">
                <Text color="white" fontSize="lg" fontWeight="semibold" textAlign="center">
                    10-Year Compound Growth Comparison
                </Text>

                {chartData.length > 0 ? (
                    <Box w="100%" h="300px" position="relative" bg="#1a2330" borderRadius="md" p={4}>
                        <VStack spacing={2} align="stretch" h="100%">
                            {/* Simple text-based chart representation */}
                            <Text color="white" fontSize="sm" textAlign="center">
                                Compound Growth Projection (10 years)
                            </Text>

                            {/* Recharts Line Chart */}
                            <Box flex="1" minH="200px" w="100%">
                                <CompoundGrowthChart chartData={chartData} symbol={symbol} />

                                {/* Yield Boost Indicator */}
                                {chartData.length > 0 && (
                                    <Box position="absolute" top="20px" right="30px">
                                        <Text
                                            color="#3b82f6"
                                            fontSize="sm"
                                            fontWeight="bold"
                                            bg="#1f2937"
                                            px={2}
                                            py={1}
                                            borderRadius="md"
                                            border="1px solid #374151"
                                        >
                                            {(() => {
                                                const lastPoint = chartData[chartData.length - 1];
                                                const boost = ((lastPoint.boostedAmount - lastPoint.baseAmount) / lastPoint.baseAmount) * 100;
                                                return `${boost.toFixed(0)}% Boost`;
                                            })()}
                                        </Text>
                                    </Box>
                                )}
                            </Box>
                        </VStack>
                    </Box>
                ) : (
                    <Box w="100%" h="300px" display="flex" alignItems="center" justifyContent="center">
                        <Text color="whiteAlpha.600" fontSize="md">
                            Enter an amount to see your 10-year compound growth projection
                        </Text>
                    </Box>
                )}
            </VStack>
        </Box>
    );
};

export default MyceliumGrowthChart;
