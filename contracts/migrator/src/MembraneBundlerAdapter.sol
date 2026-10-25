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
///         borrow against their position up to the borrow cap (the proceeds land on the owner, but the
///         position is pushed 3pp from liquidation). So the operator must be a contract that acts only
///         for the bundle's `initiator` — this adapter, the same rule CdpRouter applies to msg.sender.
///
///         Cdp pays borrow proceeds to the position OWNER, never the operator (Cdp.sol STEP 9). The
///         flash loan must be repaid inside the same transaction, so the adapter pulls exactly the
///         shortfall back from the owner. That pull is why the owner grants this adapter an allowance
///         (or an ERC-2612 permit) on the paired asset.
///
/// @dev    Holds no admin key and no state. Funds sit here only between two calls of one bundle.
///         Mirrors Bundler3's CoreAdapter (`onlyBundler3`, `initiator()`) without importing it.
interface IBundler3Initiator {
    function initiator() external view returns (address);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
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
    function position(uint256 positionId)
        external
        view
        returns (uint256 id, address owner_, uint256 pendingInterest, uint256 totalAccrued, uint256 collLen, uint256 segLen);
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

    address public immutable BUNDLER3;
    ICdpForAdapter public immutable CDP;

    error UnauthorizedSender();
    error NotOperator(address owner, address adapter);
    error NotPositionOwner(address initiator, uint256 positionId, address owner);
    error UnregisteredCollateral(bytes32 denom);
    error NoCollateral(bytes32 denom);
    error NotPegPaired(address repayToken, address paired);
    error BorrowAboveCap(uint256 borrowCdt, uint256 maxBorrowCdt);
    error ZeroAddress();

    event MembraneLegExecuted(
        address indexed owner,
        uint256 indexed positionId,
        bytes32 collateralDenom,
        uint256 collateralDeposited,
        uint256 borrowedCdt,
        uint256 proceedsPulled
    );

    constructor(address bundler3, address cdp) {
        if (bundler3 == address(0) || cdp == address(0)) revert ZeroAddress();
        BUNDLER3 = bundler3;
        CDP = ICdpForAdapter(cdp);
    }

    modifier onlyBundler3() {
        if (msg.sender != BUNDLER3) revert UnauthorizedSender();
        _;
    }

    /// @notice Deposit this adapter's whole balance of `collateralDenom`'s token into the
    ///         initiator's Membrane position, then peg-borrow exactly enough for `repayTo` to hold
    ///         `repayTarget` of the paired asset, and pull that amount from the initiator to `repayTo`.
    /// @param  positionId     0 opens a new position owned by the initiator; else it must be theirs.
    /// @param  collateralDenom Membrane denom of the collateral (its token = Cdp.assetToken(denom)).
    /// @param  maxBorrowCdt   the initiator's cap on new Membrane debt (CDT, 18 decimals). Revert above.
    /// @param  repayToken     the flash-loaned token; must be the Transmuter's paired asset.
    /// @param  repayTo        where the flash loan is repaid from (GeneralAdapter1).
    /// @param  repayTarget    the flash amount `repayTo` must hold when the callback returns.
    /// @return finalPositionId the Membrane position that now holds the collateral and the debt.
    function depositAndBorrowFor(
        uint256 positionId,
        bytes32 collateralDenom,
        uint256 maxBorrowCdt,
        address repayToken,
        address repayTo,
        uint256 repayTarget
    ) external onlyBundler3 returns (uint256 finalPositionId) {
        address owner = IBundler3Initiator(BUNDLER3).initiator();
        if (!CDP.positionOperator(owner, address(this))) revert NotOperator(owner, address(this));
        if (positionId != 0) {
            (, address posOwner,,,,) = CDP.position(positionId);
            if (posOwner != owner) revert NotPositionOwner(owner, positionId, posOwner);
        }

        // 1. collateral: everything the venue leg sent here.
        address token = CDP.assetToken(collateralDenom);
        if (token == address(0)) revert UnregisteredCollateral(collateralDenom);
        uint256 amount = IERC20Min(token).balanceOf(address(this));
        if (amount == 0) revert NoCollateral(collateralDenom);
        token.forceApprove(address(CDP), amount);
        Fund[] memory funds = new Fund[](1);
        funds[0] = Fund({denom: collateralDenom, amount: amount});
        finalPositionId = CDP.deposit(positionId, owner, funds);
        token.forceApprove(address(CDP), 0);

        // 2. debt: the shortfall, peg path (CDT minted and transmuted 1:1 to the paired asset,
        //    paid to the owner). The Cdp is fee-exempt in the Transmuter, so the payout is exact.
        uint256 have = IERC20Min(repayToken).balanceOf(repayTo);
        uint256 shortfall = repayTarget > have ? repayTarget - have : 0;
        uint256 borrowCdt;
        if (shortfall != 0) {
            ITransmuterPaired tm = ITransmuterPaired(CDP.transmuterForPeg());
            address paired = address(tm) == address(0) ? address(0) : tm.pairedAsset();
            if (paired != repayToken) revert NotPegPaired(repayToken, paired);
            borrowCdt = shortfall * tm.pairedScale();
            if (borrowCdt > maxBorrowCdt) revert BorrowAboveCap(borrowCdt, maxBorrowCdt);
            CDP.increaseDebt(finalPositionId, collateralDenom, borrowCdt, true);
            // 3. proceeds back from the owner to the flash-loan repayer.
            repayToken.safeTransferFrom(owner, repayTo, shortfall);
        }

        emit MembraneLegExecuted(owner, finalPositionId, collateralDenom, amount, borrowCdt, shortfall);
    }
}
