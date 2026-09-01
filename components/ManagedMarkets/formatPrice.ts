import { Formatter } from '@/helpers/formatter';

// Helper to format price
export const formatPrice = (value: string | number | undefined) => {
    if (value === undefined || value === null || value === '—') return '—';
    return Formatter.currency(Number(value), 4);
};
