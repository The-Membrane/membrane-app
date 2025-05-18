import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export type ManagedMarketState = {
    collateralAmount: string;
    multiplier: number;
    takeProfit: string;
    stopLoss: string;
    selectedAction: number;
};

type Store = {
    managedMarketState: ManagedMarketState;
    setManagedMarketState: (partial: Partial<ManagedMarketState>) => void;
    reset: () => void;
};

const initialState: ManagedMarketState = {
    collateralAmount: '',
    multiplier: 1,
    takeProfit: '',
    stopLoss: '',
    selectedAction: 0,
};

const useManagedMarket = create<Store>()(
    devtools(
        (set) => ({
            managedMarketState: initialState,
            setManagedMarketState: (partial: Partial<ManagedMarketState>) =>
                set((state) => ({ managedMarketState: { ...state.managedMarketState, ...partial } })),
            reset: () => set((state) => ({ ...state, managedMarketState: initialState })),
        }),
        { name: 'managedMarketState' }
    )
);

export default useManagedMarket; 