import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export type ManagedActionState = {
    collateralAmount: string;
    multiplier: number;
    takeProfit: string;
    stopLoss: string;
    selectedAction: number;
    deposit: boolean;
    borrowAmount?: string;
    closePercent?: number;
    repayAmount?: string;
};

type Store = {
    managedActionState: ManagedActionState;
    setManagedActionState: (partial: Partial<ManagedActionState>) => void;
    reset: () => void;
};

const initialState: ManagedActionState = {
    collateralAmount: '',
    multiplier: 1,
    takeProfit: '',
    stopLoss: '',
    selectedAction: 0,
    deposit: false,
    borrowAmount: '',
    repayAmount: '',
};

const useManagedAction = create<Store>()(
    devtools(
        (set) => ({
            managedActionState: initialState,
            setManagedActionState: (partial: Partial<ManagedActionState>) =>
                set((state) => ({ managedActionState: { ...state.managedActionState, ...partial } })),
            reset: () => set((state) => ({ ...state, managedActionState: initialState })),
        }),
        { name: 'managedActionState' }
    )
);

export default useManagedAction; 