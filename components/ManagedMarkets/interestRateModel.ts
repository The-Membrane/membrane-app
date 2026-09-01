import type { InterestRateModelProps } from './ManagedMarketInfo'

const calculateRateAtRatio = (ratio: number, base: number, max: number, kink: number | null, multiplier: number): number => {
    let rate;
    if (kink === null) {
        // Guarded like every other return path: `base` is a parseFloat of chain
        // data, so a non-numeric rate would otherwise escape as NaN and render
        // as "NaN%" instead of falling back to 0.
        return isNaN(base) ? 0 : base;
    }
    if (ratio <= kink) {
        rate = kink === 0 ? 0 : base * (ratio / kink);
    } else {
        rate = base + (max - base) * ((ratio - kink) / (1 - kink)) * multiplier;
    }

    if (rate > max) {
        rate = max;
    }

    return isNaN(rate) ? 0 : rate;
};

export const calculateCurrentInterestRate = ({
    baseRate,
    rateMax,
    kinkMultiplier,
    kinkPoint,
    currentRatio,
}: InterestRateModelProps): number => {
    const base = typeof baseRate === 'string' ? parseFloat(baseRate) : baseRate ?? 0;
    const max = typeof rateMax === 'string' ? parseFloat(rateMax) : rateMax ?? 0;
    const parsedKink = parseFloat(kinkPoint as string);
    const kink = isNaN(parsedKink) ? null : parsedKink;
    const parsedMultiplier = parseFloat(kinkMultiplier as string);
    const multiplier = isNaN(parsedMultiplier) ? 1 : parsedMultiplier;
    const current = currentRatio ?? 0;

    return calculateRateAtRatio(current, base, max, kink, multiplier);
};

export const getInterestRateModelPoints = (props: InterestRateModelProps) => {
    const base = typeof props.baseRate === 'string' ? parseFloat(props.baseRate) : props.baseRate ?? 0;
    const max = typeof props.rateMax === 'string' ? parseFloat(props.rateMax) : props.rateMax ?? 0;
    const parsedKink = parseFloat(props.kinkPoint as string);
    const hasKink = !isNaN(parsedKink);
    const kink = hasKink ? parsedKink : null;
    const parsedMultiplier = parseFloat(props.kinkMultiplier as string);
    const multiplier = isNaN(parsedMultiplier) ? 1 : parsedMultiplier;

    const points = Array.from({ length: 51 }, (_, i) => {
        const ratio = i / 50;
        const rate = calculateRateAtRatio(ratio, base, max, kink, multiplier);
        return { ratio, rate };
    });

    return { points, max, hasKink };
}
