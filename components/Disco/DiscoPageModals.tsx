import React from 'react'
import { SlotManageModal } from './SlotManageModal'
import { DepositModal } from './DepositModal'
import type { DiscoPageState } from './hooks/useDiscoPage'

interface DiscoPageModalsProps {
    manageSlot: DiscoPageState['manageSlot']
    setManageSlot: DiscoPageState['setManageSlot']
    userSlotDeposits: DiscoPageState['userSlotDeposits']
    unstakeData: DiscoPageState['unstakeData']
    firstAsset: string
    slotsData: DiscoPageState['slotsData']
    depositModalSlot: DiscoPageState['depositModalSlot']
    setDepositModalSlot: DiscoPageState['setDepositModalSlot']
    selectedSlotDataWithAPR: DiscoPageState['selectedSlotDataWithAPR']
    walletBalanceMBRN: string
    depositAmount: string
    setDepositAmount: DiscoPageState['setDepositAmount']
    handleDeposit: DiscoPageState['handleDeposit']
    depositHook: DiscoPageState['depositHook']
}

/** Slot-manage and deposit modals rendered outside the main page flow. */
export const DiscoPageModals: React.FC<DiscoPageModalsProps> = ({
    manageSlot,
    setManageSlot,
    userSlotDeposits,
    unstakeData,
    firstAsset,
    slotsData,
    depositModalSlot,
    setDepositModalSlot,
    selectedSlotDataWithAPR,
    walletBalanceMBRN,
    depositAmount,
    setDepositAmount,
    handleDeposit,
    depositHook,
}) => {
    return (
        <>
            {/* Slot Manage Modal */}
            {manageSlot !== null && (() => {
                const slotInfo = userSlotDeposits.slots.find(s => s.slot === manageSlot)
                    || { amount: 0, claimable: 0, lifetime: 0, apr: 0, count: 0 }
                const slotUnstakeRequests = (unstakeData?.requests || []).filter((req: any) => req.slot === manageSlot)
                return (
                    <SlotManageModal
                        isOpen={true}
                        onClose={() => setManageSlot(null)}
                        slot={manageSlot}
                        slotData={slotInfo}
                        asset={firstAsset}
                        unstakeRequests={slotUnstakeRequests}
                        availableSlots={slotsData.map(s => s.slot)}
                    />
                )
            })()}
            {/* Deposit Modal */}
            {depositModalSlot !== null && (
                <DepositModal
                    isOpen={true}
                    onClose={() => {
                        setDepositModalSlot(null)
                        setDepositAmount('')
                    }}
                    slot={depositModalSlot}
                    apr={selectedSlotDataWithAPR?.apr}
                    walletBalance={walletBalanceMBRN || '0'}
                    depositAmount={depositAmount}
                    onDepositAmountChange={setDepositAmount}
                    onDeposit={handleDeposit}
                    isLoading={depositHook.action?.tx?.isPending}
                    isDisabled={!depositHook.action?.simulate?.data}
                    slotsData={slotsData}
                />
            )}
        </>
    )
}
