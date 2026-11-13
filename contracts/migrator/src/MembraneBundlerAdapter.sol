// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  MembraneBundlerAdapter
/// @notice The Membrane leg of a flash-loan migration run through Morpho Bundler3.
///
///         Everything else in the flow is an EXISTING deployed contract:
///           - flash loan            Morpho Blue, via Bundler3 GeneralAdapter1.morphoFlashLoan (fee-free)
///           - Aave V3 / Spark leg   Bundler3 AaveV3MigrationAdapter.aaveV3Repay / aaveV3Withdraw
///           - Morpho Blue leg       GeneralAdapter1.morphoRepay / morphoWithdrawCollateral
///           - token pulls           GeneralAdapter1.erc20TransferFrom (aTokens), this adapter (proceeds)
///
///         WHY THIS ONE CONTRACT EXISTS (owner ruling 2026-10-25: periphery only, no core change):
///         Cdp.increaseDebt is gated on `msg.sender == owner || positionOperator[owner][msg.sender]`
///         (Cdp.sol `_authorizedFor`). Inside a bundle the caller is Bundler3, a public contract that
///         executes ANY caller's calls. A user who made Bundler3 their Cdp operator would let anyone
///         borrow against their position up to the Cdp's own gate. So the operator must be a
///         contract that acts only for the bundle's `initiator` — this adapter.
///
///         Cdp pays borrow proceeds to the position OWNER, never the operator (Cdp.sol STEP 9). The
///         flash loan must be repaid inside the same transaction, so the adapter pulls the payout
///         back from the owner to GeneralAdapter1. That pull is why the owner permits this adapter
///         an exact amount of the paired asset.
///
///         WHAT A STANDING OPERATOR GRANT TO THIS ADAPTER CAN DO (review M-1):
///           - only inside a Bundler3 bundle the OWNER sent (initiator check);
///           - only OPEN A NEW position for the owner (there is no position id argument), funded by
///             collateral already sitting in this adapter, and borrow on that NEW position;
///           - the borrow is capped at the caller's `maxLtvWad` and at the asset's live max LTV
///             minus the 3pp borrow gap (checked here, after the borrow, at Membrane's prices);
///           - the payout goes to the owner and is pulled back only to GeneralAdapter1 (immutable),
///             only up to the owner's ERC-20 allowance to this adapter, and only if the payout is
///             exactly what the borrow should pay (no fee can make it pull more).
///           It cannot touch any existing position, withdraw, or send funds to any other address.
///
/// @dev    Holds no admin key and no state. Funds sit here only between two calls of one bundle.
///         Mirrors Bundler3's CoreAdapter (`onlyBundler3`, `initiator()`) without importing it.
interface IBundler3Initiator {
    function initiator() external view returns (address);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

/// @notice The Fund struct Cdp.deposit takes (CdpInternal.Fund). Same ABI layout.
struct Fund {
    bytes32 denom;
    uint256 amount;
}

interface ICdpForAdapter {
    function deposit(uint256 positionId, address positionOwner, Fund[] calldata funds)
        external
        returns (uint256 finalPositionId);
    function increaseDebt(uint256 positionId, bytes32 borrowAsset, uint256 amount, bool pegDebt) external;
    function positionOperator(address owner, address operator) external view returns (bool);
    function assetToken(bytes32 denom) external view returns (address);
    function transmuterForPeg() external view returns (address);
    function collateral() external view returns (address);
    function positionCollateralValue(uint256 positionId) external view returns (uint256);
    function positionDebt(uint256 positionId) external view returns (uint256);
    function creditPriceSource() external view returns (uint8 source, uint256 price);
}

interface ICollateralLtv {
    function currentMaxLTV(bytes32 asset) external view returns (uint256);
}

interface ITransmuterPaired {
    function pairedAsset() external view returns (address);
    function pairedScale() external view returns (uint256);
}

library SafeTransferLib {
    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "TRANSFER_FROM_FAILED");
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            (ok, ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
            require(ok, "APPROVE_RESET_FAILED");
            (ok, ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "APPROVE_FAILED");
        }
    }
}

contract MembraneBundlerAdapter {
    using SafeTransferLib for address;

    /// @notice Membrane's borrow gap: borrow LTV = max LTV − 3pp (lib/Constants.sol BORROW_LTV_GAP).
    ///         Cdp._increaseDebt gates only on max LTV, so the adapter enforces the gap itself.
    uint256 public constant BORROW_LTV_GAP = 3e16;
    uint256 internal constant WAD = 1e18;

    address public immutable BUNDLER3;
    ICdpForAdapter public immutable CDP;
    /// @notice Where the proceeds go back to: Bundler3's GeneralAdapter1, which repays the flash loan.
    address public immutable REPAY_TO;

    error UnauthorizedSender();
    error NotOperator(address owner, address adapter);
    error UnregisteredCollateral(bytes32 denom);
    error NoCollateral(bytes32 denom);
    error ZeroBorrow();
    error NotPegPaired(address repayToken, address paired);
    error PayoutMismatch(uint256 received, uint256 expected);
    error LtvAboveCap(uint256 ltvWad, uint256 capWad);
    error ZeroAddress();

    event MembraneLegExecuted(
        address indexed owner,
        uint256 indexed positionId,
        bytes32 collateralDenom,
        uint256 collateralDeposited,
        uint256 borrowedCdt,
        uint256 proceedsPulled,
        uint256 ltvWad
    );

    constructor(address bundler3, address cdp, address repayTo) {
        if (bundler3 == address(0) || cdp == address(0) || repayTo == address(0)) revert ZeroAddress();
        BUNDLER3 = bundler3;
        CDP = ICdpForAdapter(cdp);
        REPAY_TO = repayTo;
    }

    modifier onlyBundler3() {
        if (msg.sender != BUNDLER3) revert UnauthorizedSender();
        _;
    }

    /// @notice Open a NEW Membrane position for the initiator with this adapter's whole balance of
    ///         `collateralDenom`'s token, peg-borrow exactly `borrowCdt`, check the resulting LTV, and
    ///         pull the payout from the initiator to REPAY_TO (GeneralAdapter1).
    /// @param  collateralDenom Membrane denom of the collateral (its token = Cdp.assetToken(denom)).
    /// @param  borrowCdt      the exact new Membrane debt (CDT, 18 decimals); must pay out whole
    ///                        paired units.
    /// @param  repayToken     the flash-loaned token; must be the Transmuter's paired asset.
    /// @param  maxLtvWad      the initiator's LTV cap; the effective cap is the lower of this and
    ///                        the asset's live max LTV − 3pp.
    function depositAndBorrowFor(bytes32 collateralDenom, uint256 borrowCdt, address repayToken, uint256 maxLtvWad)
        external
        onlyBundler3
        returns (uint256 positionId)
    {
        address owner = IBundler3Initiator(BUNDLER3).initiator();
        if (!CDP.positionOperator(owner, address(this))) revert NotOperator(owner, address(this));
        if (borrowCdt == 0) revert ZeroBorrow();

        // 1. collateral: everything the venue leg sent here, into a NEW position.
        address token = CDP.assetToken(collateralDenom);
        if (token == address(0)) revert UnregisteredCollateral(collateralDenom);
        uint256 amount = IERC20Min(token).balanceOf(address(this));
        if (amount == 0) revert NoCollateral(collateralDenom);
        token.forceApprove(address(CDP), amount);
        Fund[] memory funds = new Fund[](1);
        funds[0] = Fund({denom: collateralDenom, amount: amount});
        positionId = CDP.deposit(0, owner, funds);
        token.forceApprove(address(CDP), 0);

        // 2. debt: peg path (CDT minted, transmuted 1:1 to the paired asset, paid to the owner).
        ITransmuterPaired tm = ITransmuterPaired(CDP.transmuterForPeg());
        address paired = address(tm) == address(0) ? address(0) : tm.pairedAsset();
        if (paired != repayToken) revert NotPegPaired(repayToken, paired);
        uint256 expected = borrowCdt / tm.pairedScale();
        uint256 before = IERC20Min(repayToken).balanceOf(owner);
        CDP.increaseDebt(positionId, collateralDenom, borrowCdt, true);
        uint256 received = IERC20Min(repayToken).balanceOf(owner) - before;
        if (received != expected) revert PayoutMismatch(received, expected);

        // 3. the borrow LTV, at Membrane's own prices, in this same call.
        uint256 cap = ICollateralLtv(CDP.collateral()).currentMaxLTV(collateralDenom);
        cap = cap > BORROW_LTV_GAP ? cap - BORROW_LTV_GAP : 0;
        if (maxLtvWad < cap) cap = maxLtvWad;
        (, uint256 creditPrice) = CDP.creditPriceSource();
        uint256 debtValue = (CDP.positionDebt(positionId) * creditPrice) / WAD;
        uint256 collValue = CDP.positionCollateralValue(positionId);
        uint256 ltv = collValue == 0 ? type(uint256).max : (debtValue * WAD) / collValue;
        if (ltv > cap) revert LtvAboveCap(ltv, cap);

        // 4. the payout back to the flash-loan repayer, exactly what was received.
        repayToken.safeTransferFrom(owner, REPAY_TO, received);

        emit MembraneLegExecuted(owner, positionId, collateralDenom, amount, borrowCdt, received, ltv);
    }
}
