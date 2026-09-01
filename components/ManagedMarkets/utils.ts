// Helper to format TVL as $X.XXK/M
export function formatTvl(val: number): string {
    if (isNaN(val)) return '$0';
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${val.toFixed(2)}`;
}
