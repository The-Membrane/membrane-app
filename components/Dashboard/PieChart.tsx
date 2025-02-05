import { PieChart, Pie, Cell, Tooltip } from "recharts";

const getColorFromName = (name) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = ["#4fcabb", "#3d414b", "#6a737d", "#8a939f", "#b0b8c4"];
    return colors[Math.abs(hash) % colors.length];
};

const AssetPieChart = ({ data }) => {
    return (
        <PieChart width={400} height={400}>
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
            <Tooltip formatter={(value, name) => [`Total: ${value}`, `Asset: ${name}`]} />
        </PieChart>
    );
};

export default AssetPieChart;
