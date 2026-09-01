import { Stack, Text } from "@chakra-ui/react";
import { lazyChart } from "@/components/ui/lazyChart";
import { SEMANTIC_COLORS } from "@/config/semanticColors";
import { TYPOGRAPHY } from "@/helpers/typography";

const getColorFromName = (name: string) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 10%, 50%)`; // Muted, neutral tones
};

const CompositionPie = lazyChart<{ data: any[] }>(({ PieChart, Pie, Cell, Tooltip }) =>
    function CompositionPie({ data }) {
        return (
            <PieChart width={650} height={500}>
                <Pie
                    data={data}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={150}
                    label={({ name, percent }) =>
                        percent > 0.1 ? `${name}: ${(percent * 100).toFixed(1)}%` : ""
                    }
                >
                    {data.map((entry: any) => (
                        <Cell key={entry.name} fill={getColorFromName(entry.name)} />
                    ))}
                </Pie>
                <Tooltip formatter={(value, name) => [`Total: $${value}`, `Asset: ${name}`]} />
            </PieChart>
        );
    }, 500);

const AssetPieChart = ({ data }: { data: any[] }) => {
    return (
        <Stack w="100%" maxW="650px">
            <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} display="flex" color={SEMANTIC_COLORS.textPrimary}>Collateral Composition</Text>
            <CompositionPie data={data} />
        </Stack>

    );
};

export default AssetPieChart;
