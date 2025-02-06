import { colors } from "@/config/defaults";
import { Stack, Text } from "@chakra-ui/react";
import { PieChart, Pie, Cell, Tooltip } from "recharts";

const getColorFromName = (name) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 10%, 50%)`; // Muted, neutral tones
};

const AssetPieChart = ({ data }) => {
    return (
        <Stack justifyContent={"center"}>
            <Text fontWeight="bold" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={colors.earnText}>Collateral Composition</Text>
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
                    {data.map((entry) => (
                        <Cell key={entry.name} fill={getColorFromName(entry.name)} />
                    ))}
                </Pie>
                <Tooltip formatter={(value, name) => [`Total: $${value}`, `Asset: ${name}`]} />
            </PieChart>
        </Stack>

    );
};

export default AssetPieChart;
