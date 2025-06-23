import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export type LendState = {
    supplyAmount: string;
};

type Store = {
    lendState: LendState;
    setLendState: (partial: Partial<LendState>) => void;
    reset: () => void;
};

const initialState: LendState = {
    supplyAmount: '',
};

const useLendState = create<Store>()(
    devtools(
        (set) => ({
            lendState: initialState,
            setLendState: (partial: Partial<LendState>) =>
                set((state) => ({ lendState: { ...state.lendState, ...partial } })),
            reset: () => set((state) => ({ ...state, lendState: initialState })),
        }),
        { name: 'lendState' }
    )
);

export default useLendState; 