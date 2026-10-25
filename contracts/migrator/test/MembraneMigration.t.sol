// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {Bundler3} from "bundler3/Bundler3.sol";
import {Call} from "bundler3/interfaces/IBundler3.sol";
import {GeneralAdapter1} from "bundler3/adapters/GeneralAdapter1.sol";
import {AaveV3MigrationAdapter} from "bundler3/adapters/migration/AaveV3MigrationAdapter.sol";
import {CoreAdapter} from "bundler3/adapters/CoreAdapter.sol";

import {IMorpho, IMorphoBase, MarketParams, Authorization, Signature, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {AUTHORIZATION_TYPEHASH} from "morpho-blue/libraries/ConstantsLib.sol";

import {RW_Oracle} from "membrane/test/RealWiringFixture.sol";
import {Cdp} from "membrane/contracts/Cdp.sol";
import {CdpInternal} from "membrane/contracts/lib/CdpInternal.sol";
import {MembraneToken} from "membrane/contracts/lib/Tokenfactory.sol";

import {MembraneStack} from "../script/MembraneStack.sol";
import {MembraneBundlerAdapter} from "../src/MembraneBundlerAdapter.sol";
import {MockAaveV3Pool, MockAToken} from "./mocks/MockAaveV3.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice End-to-end on MembraneStack: real Cdp / Collateral / Debt / Transmuter (peg seam wired),
///         6-decimal USDC with the version-"2" permit domain, real Morpho Blue, real Bundler3 /
///         GeneralAdapter1 / AaveV3MigrationAdapter, an Aave V3 pool double. The bundles here are
///         the ones lib/migrate/bundle.ts builds.
contract MembraneMigrationTest is Test, MembraneStack {
    using MarketParamsLib for MarketParams;

    S internal s;
    Cdp internal cdp;
    IMorpho internal morpho;
    Bundler3 internal bundler;
    GeneralAdapter1 internal ga1;
    AaveV3MigrationAdapter internal aaveAdapter;
    MembraneBundlerAdapter internal mAdapter;
    MockAaveV3Pool internal aave;
    MockAToken internal aWeth;
    MockUSDC internal usdc;
    MembraneToken internal weth;
    RW_Oracle internal oracle;
    MarketParams internal mkt;

    address internal user;
    uint256 internal userPk;
    address internal constant BOB = address(0x2222);
    address internal constant ATTACKER = address(0xBAD);

    uint256 internal constant COLL = 10e18; // 10 WETH @ $2,000 = $20,000
    uint256 internal constant DEBT = 12_000e6; // 60% LTV
    uint256 internal constant SCALE = 1e12; // USDC (6) -> CDT (18)
    uint256 internal constant BUFFER_BPS = 2; // lib/migrate/plan.ts ACCRUAL_BUFFER_BPS
    uint256 internal constant BORROW_LTV = 77e16; // WETH max 80% − 3pp
    uint256 internal constant MARGIN = 5e15; // lib/migrate/plan.ts LTV_MARGIN (0.5pp)

    function setUp() public {
        s = _deployStack(address(this));
        (user, userPk) = makeAddrAndKey("looper");
        cdp = s.cdp;
        morpho = s.morpho;
        bundler = s.bundler;
        ga1 = s.ga1;
        aaveAdapter = s.aaveAdapter;
        mAdapter = s.mAdapter;
        aave = s.aave;
        usdc = s.usdc;
        weth = s.weth;
        oracle = s.oracle;
        mkt = s.mkt;
        aWeth = MockAToken(aave.aTokenOf(address(weth)));
        weth.mint(user, 100e18);
    }

    // ------------------------------------------------------------------ helpers

    function _c(address to, bytes memory data) internal pure returns (Call memory) {
        return Call({to: to, data: data, value: 0, skipRevert: false, callbackHash: bytes32(0)});
    }

    function _permitCall(address token, address spender, uint256 value) internal view returns (Call memory) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                user, spender, value, IERC20Permit(token).nonces(user), deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(userPk, digest);
        return Call({
            to: token,
            data: abi.encodeCall(IERC20Permit.permit, (user, spender, value, deadline, v, r, ss)),
            value: 0,
            skipRevert: true,
            callbackHash: bytes32(0)
        });
    }

    function _morphoAuthCall() internal view returns (Call memory) {
        Authorization memory auth = Authorization({
            authorizer: user,
            authorized: address(ga1),
            isAuthorized: true,
            nonce: morpho.nonce(user),
            deadline: block.timestamp + 1 hours
        });
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", morpho.DOMAIN_SEPARATOR(), keccak256(abi.encode(AUTHORIZATION_TYPEHASH, auth)))
        );
        Signature memory sig;
        (sig.v, sig.r, sig.s) = vm.sign(userPk, digest);
        return Call({
            to: address(morpho),
            data: abi.encodeCall(IMorphoBase.setAuthorizationWithSig, (auth, sig)),
            value: 0,
            skipRevert: true,
            callbackHash: bytes32(0)
        });
    }

    function _flash(uint256 amount, Call[] memory inner) internal view returns (Call memory) {
        bytes memory data = abi.encode(inner);
        return Call({
            to: address(ga1),
            data: abi.encodeCall(GeneralAdapter1.morphoFlashLoan, (address(usdc), amount, data)),
            value: 0,
            skipRevert: false,
            callbackHash: keccak256(data)
        });
    }

    function _membraneLeg(uint256 proceeds, uint256 maxLtv) internal view returns (Call memory) {
        return _c(
            address(mAdapter),
            abi.encodeCall(MembraneBundlerAdapter.depositAndBorrowFor, (WETH, proceeds * SCALE, address(usdc), maxLtv))
        );
    }

    function _sweepToUser() internal view returns (Call memory) {
        return _c(address(ga1), abi.encodeCall(CoreAdapter.erc20Transfer, (address(usdc), user, type(uint256).max)));
    }

    function _withBuffer(uint256 x) internal pure returns (uint256) {
        return (x * (10_000 + BUFFER_BPS) + 9_999) / 10_000;
    }

    function _openAave(uint256 coll, uint256 debt_) internal {
        vm.startPrank(user);
        weth.approve(address(aave), coll);
        aave.supply(address(weth), coll, user, 0);
        aave.borrow(address(usdc), debt_, 2, 0, user);
        vm.stopPrank();
    }

    function _openMorpho(uint256 coll, uint256 debt_) internal {
        vm.startPrank(user);
        weth.approve(address(morpho), coll);
        morpho.supplyCollateral(mkt, coll, user, "");
        morpho.borrow(mkt, debt_, 0, user, user);
        vm.stopPrank();
    }

    /// The Aave bundle, exactly as lib/migrate/bundle.ts builds it: exact permits, exact borrow,
    /// the unspent part of the proceeds swept back to the owner.
    function _aaveBundle(uint256 proceeds, uint256 aTokens, uint256 maxLtv) internal view returns (Call[] memory outer) {
        Call[] memory inner = new Call[](6);
        inner[0] = _c(address(ga1), abi.encodeCall(CoreAdapter.erc20Transfer, (address(usdc), address(aaveAdapter), type(uint256).max)));
        inner[1] = _c(address(aaveAdapter), abi.encodeCall(AaveV3MigrationAdapter.aaveV3Repay, (address(usdc), type(uint256).max, 2, user)));
        inner[2] = _c(address(aaveAdapter), abi.encodeCall(CoreAdapter.erc20Transfer, (address(usdc), address(ga1), type(uint256).max)));
        inner[3] = _c(address(ga1), abi.encodeCall(GeneralAdapter1.erc20TransferFrom, (address(aWeth), address(aaveAdapter), aTokens)));
        inner[4] = _c(address(aaveAdapter), abi.encodeCall(AaveV3MigrationAdapter.aaveV3Withdraw, (address(weth), type(uint256).max, address(mAdapter))));
        inner[5] = _membraneLeg(proceeds, maxLtv);
        outer = new Call[](4);
        outer[0] = _permitCall(address(aWeth), address(ga1), aTokens);
        outer[1] = _permitCall(address(usdc), address(mAdapter), proceeds);
        outer[2] = _flash(proceeds, inner);
        outer[3] = _sweepToUser();
    }

    function _morphoBundle(uint256 proceeds, uint256 maxLtv) internal view returns (Call[] memory outer) {
        Call[] memory inner = new Call[](3);
        inner[0] = _c(address(ga1), abi.encodeCall(GeneralAdapter1.morphoRepay, (mkt, 0, type(uint256).max, type(uint256).max, user, bytes(""))));
        inner[1] = _c(address(ga1), abi.encodeCall(GeneralAdapter1.morphoWithdrawCollateral, (mkt, type(uint256).max, address(mAdapter))));
        inner[2] = _membraneLeg(proceeds, maxLtv);
        outer = new Call[](4);
        outer[0] = _morphoAuthCall();
        outer[1] = _permitCall(address(usdc), address(mAdapter), proceeds);
        outer[2] = _flash(proceeds, inner);
        outer[3] = _sweepToUser();
    }

    function _assertNoResidue() internal view {
        address[3] memory holders = [address(ga1), address(aaveAdapter), address(mAdapter)];
        for (uint256 i; i < 3; ++i) {
            assertEq(usdc.balanceOf(holders[i]), 0, "USDC residue");
            assertEq(weth.balanceOf(holders[i]), 0, "WETH residue");
            assertEq(aWeth.balanceOf(holders[i]), 0, "aWETH residue");
            assertEq(s.cdt.balanceOf(holders[i]), 0, "CDT residue");
        }
    }

    function _onlyPosition() internal view returns (uint256 pid) {
        pid = cdp.userPositionIds(user, 0);
        (, address owner_,,,,) = cdp.position(pid);
        assertEq(owner_, user, "Membrane position owner");
    }

    function _grant() internal {
        vm.prank(user);
        cdp.setPositionOperator(address(mAdapter), true);
    }

    /// Open on Aave at `debt_` and migrate with maxLtv `cap` (expect success).
    function _migrateAave(uint256 debt_, uint256 cap) internal {
        _openAave(COLL, debt_);
        _grant();
        Call[] memory b = _aaveBundle(_withBuffer(debt_), COLL, cap);
        vm.prank(user);
        bundler.multicall(b);
    }

    function _expectAaveRevert(uint256 debt_, uint256 cap, bytes memory err) internal {
        _openAave(COLL, debt_);
        _grant();
        Call[] memory b = _aaveBundle(_withBuffer(debt_), COLL, cap);
        vm.prank(user);
        vm.expectRevert(err);
        bundler.multicall(b);
        assertEq(aave.variableDebt(address(usdc), user), debt_, "nothing moved");
        assertEq(aWeth.balanceOf(user), COLL, "nothing moved");
    }

    // ------------------------------------------------------------------ Aave V3

    /// Prompts on a plain EOA: setPositionOperator (tx, once) + aToken permit + USDC permit + bundle.
    function test_AaveMigration_EndToEnd() public {
        _openAave(COLL, DEBT);
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 morphoUsdcBefore = usdc.balanceOf(address(morpho));
        uint256 proceeds = _withBuffer(DEBT);
        aave.accrueDebt(address(usdc), user, 1e6); // interest between the read and the block
        uint256 owed = DEBT + 1e6;
        _grant();
        Call[] memory b = _aaveBundle(proceeds, COLL, BORROW_LTV - MARGIN);
        vm.prank(user);
        bundler.multicall(b);

        assertEq(aave.variableDebt(address(usdc), user), 0, "Aave debt repaid");
        assertEq(aWeth.balanceOf(user), 0, "aTokens moved");
        uint256 pid = _onlyPosition();
        assertEq(cdp.positionDebt(pid), proceeds * SCALE, "Membrane debt == the signed borrow");
        assertEq(cdp.positionCollateralValue(pid), 20_000e18, "collateral value moved");
        // no extra capital: the buffer the venue did not need comes back as USDC
        assertEq(usdc.balanceOf(user), usdcBefore + (proceeds - owed), "unspent buffer returned");
        assertEq(usdc.balanceOf(address(morpho)), morphoUsdcBefore, "flash repaid, fee 0");
        _assertNoResidue();
    }

    /// Review M-2: exact permits leave no allowance behind (inverts probe ResidualAllowance).
    function test_AaveMigration_NoResidualAllowance() public {
        _migrateAave(DEBT, BORROW_LTV - MARGIN);
        assertEq(usdc.allowance(user, address(mAdapter)), 0, "proceeds allowance consumed");
        assertEq(aWeth.allowance(user, address(ga1)), 0, "aToken allowance consumed");
    }

    // ------------------------------------------------------------------ the borrow-LTV band (review H-1)

    function test_Band_76_4_Opens_WithMargin() public {
        _migrateAave(15_280e6, BORROW_LTV - MARGIN); // 76.4% + 2 bps borrowed ≤ 76.5%
        assertEq(cdp.positionDebt(_onlyPosition()), _withBuffer(15_280e6) * SCALE);
    }

    function test_Band_76_9_RevertsUnderMargin() public {
        uint256 d = 15_380e6; // 76.9%
        uint256 borrowed = _withBuffer(d) * SCALE * 1e18 / 20_000e18;
        _expectAaveRevert(d, BORROW_LTV - MARGIN, abi.encodeWithSelector(MembraneBundlerAdapter.LtvAboveCap.selector, borrowed, BORROW_LTV - MARGIN));
    }

    function test_Band_77_0_OpensWithoutMargin() public {
        _migrateAave(15_396e6, BORROW_LTV); // 76.98% + 2 bps = 76.995%
        assertEq(cdp.positionDebt(_onlyPosition()), _withBuffer(15_396e6) * SCALE);
    }

    function test_Band_77_5_Reverts() public {
        uint256 d = 15_500e6;
        uint256 borrowed = _withBuffer(d) * SCALE * 1e18 / 20_000e18;
        _expectAaveRevert(d, BORROW_LTV, abi.encodeWithSelector(MembraneBundlerAdapter.LtvAboveCap.selector, borrowed, BORROW_LTV));
    }

    /// Inverts probe OpensAt795: the Cdp alone would open 79.5% (it gates on max LTV, 80%); the
    /// adapter enforces max − 3pp even when the caller asks for more.
    function test_Band_79_5_RevertsEvenWithCallerCapAt100() public {
        uint256 d = 15_900e6;
        uint256 borrowed = _withBuffer(d) * SCALE * 1e18 / 20_000e18;
        _expectAaveRevert(d, 1e18, abi.encodeWithSelector(MembraneBundlerAdapter.LtvAboveCap.selector, borrowed, BORROW_LTV));
    }

    function test_Band_82_RevertsInTheCdp() public {
        _expectAaveRevert(16_400e6, BORROW_LTV, abi.encodeWithSelector(Cdp.InsolventAfterAction.selector));
    }

    /// An oracle drop between the read (75% at $2,000) and execution ($1,900 → 79%) reverts the
    /// whole bundle in the adapter's same-call LTV check, though the Cdp's own gate would pass.
    function test_OracleDropBetweenReadAndExecution_Reverts() public {
        uint256 d = 15_000e6;
        _openAave(COLL, d);
        _grant();
        Call[] memory b = _aaveBundle(_withBuffer(d), COLL, BORROW_LTV - MARGIN);
        oracle.setPrice(WETH, 1900e18);
        uint256 borrowed = _withBuffer(d) * SCALE * 1e18 / 19_000e18;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapter.LtvAboveCap.selector, borrowed, BORROW_LTV - MARGIN));
        bundler.multicall(b);
    }

    function test_OracleRiseBetweenReadAndExecution_Opens() public {
        uint256 d = 15_000e6;
        _openAave(COLL, d);
        _grant();
        Call[] memory b = _aaveBundle(_withBuffer(d), COLL, BORROW_LTV - MARGIN);
        oracle.setPrice(WETH, 2100e18);
        vm.prank(user);
        bundler.multicall(b);
        assertEq(cdp.positionDebt(_onlyPosition()), _withBuffer(d) * SCALE);
    }

    /// Interest beyond the buffer: the flash amount no longer covers the debt, the withdraw of the
    /// collateral fails Aave's health check, and nothing moves (no dust debt left behind).
    function test_DebtGrewPastBuffer_Reverts() public {
        _openAave(COLL, DEBT);
        _grant();
        Call[] memory b = _aaveBundle(_withBuffer(DEBT), COLL, BORROW_LTV - MARGIN);
        aave.accrueDebt(address(usdc), user, 100e6);
        vm.prank(user);
        vm.expectRevert(bytes("35")); // Aave HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD on the aToken move
        bundler.multicall(b);
        assertEq(aave.variableDebt(address(usdc), user), DEBT + 100e6, "nothing moved");
    }

    function test_AaveMigration_WithoutOperatorGrant_Reverts() public {
        _openAave(COLL, DEBT);
        Call[] memory b = _aaveBundle(_withBuffer(DEBT), COLL, BORROW_LTV - MARGIN);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapter.NotOperator.selector, user, address(mAdapter)));
        bundler.multicall(b);
    }

    // ------------------------------------------------------------------ Morpho Blue

    /// Prompts on a plain EOA: setPositionOperator (tx, once) + Morpho authorization sig + USDC permit + bundle.
    function test_MorphoMigration_EndToEnd() public {
        _openMorpho(COLL, DEBT);
        skip(1 days);
        uint256 usdcBefore = usdc.balanceOf(user);
        // the app reads the owed assets (shares → assets, rounded up) and adds the buffer
        uint256 proceeds = _withBuffer(DEBT + DEBT / 1000);
        _grant();
        Call[] memory b = _morphoBundle(proceeds, BORROW_LTV - MARGIN);
        vm.prank(user);
        bundler.multicall(b);

        (, uint128 borrowShares, uint128 collateral_) = _pos(mkt.id(), user);
        assertEq(borrowShares, 0, "Morpho debt repaid");
        assertEq(collateral_, 0, "Morpho collateral moved");
        uint256 pid = _onlyPosition();
        assertEq(cdp.positionDebt(pid), proceeds * SCALE, "Membrane debt == the signed borrow");
        assertGt(usdc.balanceOf(user), usdcBefore, "unspent buffer returned");
        assertEq(usdc.allowance(user, address(mAdapter)), 0, "proceeds allowance consumed");
        _assertNoResidue();
    }

    function _pos(Id id, address who) internal view returns (uint256 sh, uint128 b, uint128 c) {
        (bool ok, bytes memory ret) = address(morpho).staticcall(abi.encodeWithSignature("position(bytes32,address)", id, who));
        require(ok, "position");
        (sh, b, c) = abi.decode(ret, (uint256, uint128, uint128));
    }

    // ------------------------------------------------------------------ security

    /// WHY THE ADAPTER EXISTS: if a user made Bundler3 itself their Cdp operator, anyone could
    /// borrow against their position through a bundle of their own.
    function test_Reason_Bundler3AsOperatorLetsAnyoneBorrow() public {
        vm.startPrank(user);
        weth.approve(address(cdp), COLL);
        uint256 pid = cdp.deposit(0, user, _funds(COLL));
        cdp.setPositionOperator(address(bundler), true);
        vm.stopPrank();
        Call[] memory evil = new Call[](1);
        evil[0] = _c(address(cdp), abi.encodeWithSignature("increaseDebt(uint256,bytes32,uint256)", pid, WETH, 15_000e18));
        vm.prank(ATTACKER);
        bundler.multicall(evil);
        assertEq(cdp.positionDebt(pid), 15_000e18, "attacker pushed the victim's debt");
    }

    function _funds(uint256 a) internal pure returns (CdpInternal.Fund[] memory f) {
        f = new CdpInternal.Fund[](1);
        f[0] = CdpInternal.Fund({denom: WETH, amount: a});
    }

    /// Inverts probe RepayToArbitrary (review M-1). With a standing grant AND a broad USDC approval,
    /// a bundle the victim later signs from a hostile front end can no longer touch an existing
    /// position or route proceeds to an arbitrary address. What remains: it can open a NEW position
    /// funded only by collateral already in the adapter (here the attacker's own donation), borrow at
    /// most the borrow LTV of it, and the proceeds land in GA1, from where the same hostile bundle can
    /// sweep them. The attacker then receives at most the borrow-LTV share of collateral THEY gave.
    function test_StandingGrant_CannotTouchExistingPosition() public {
        _migrateAave(DEBT, BORROW_LTV - MARGIN);
        uint256 pid = _onlyPosition();
        uint256 debtBefore = cdp.positionDebt(pid);
        vm.prank(user);
        usdc.approve(address(mAdapter), type(uint256).max);
        weth.mint(ATTACKER, 1e15); // $2
        vm.prank(ATTACKER);
        weth.transfer(address(mAdapter), 1e15);
        Call[] memory evil = new Call[](2);
        evil[0] = _c(address(mAdapter), abi.encodeCall(MembraneBundlerAdapter.depositAndBorrowFor, (WETH, 1e18, address(usdc), 1e18)));
        evil[1] = _c(address(ga1), abi.encodeCall(CoreAdapter.erc20Transfer, (address(usdc), ATTACKER, type(uint256).max)));
        vm.prank(user);
        bundler.multicall(evil);
        assertEq(cdp.positionDebt(pid), debtBefore, "existing position untouched");
        assertEq(usdc.balanceOf(ATTACKER), 1e6, "attacker got $1 for $2 of their own collateral");
        assertEq(cdp.userPositionIds(user, 1) != pid, true, "a new position, owned by the victim");
    }

    function test_Adapter_BorrowAboveCollateralBorrowLtv_Reverts() public {
        _grant();
        vm.prank(address(this));
        weth.mint(address(mAdapter), 1e15); // $2
        Call[] memory b = new Call[](1);
        b[0] = _c(address(mAdapter), abi.encodeCall(MembraneBundlerAdapter.depositAndBorrowFor, (WETH, 1.6e18, address(usdc), 1e18)));
        vm.prank(user);
        vm.expectRevert(); // 80% on $2: the Cdp or the adapter refuses
        bundler.multicall(b);
    }

    function test_Adapter_AttackerCannotBorrowForVictim() public {
        _grant();
        weth.mint(address(mAdapter), 1e18);
        Call[] memory evil = new Call[](1);
        evil[0] = _membraneLeg(100e6, 1e18);
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapter.NotOperator.selector, ATTACKER, address(mAdapter)));
        bundler.multicall(evil);
    }

    function test_Adapter_RejectsDirectCalls() public {
        vm.expectRevert(MembraneBundlerAdapter.UnauthorizedSender.selector);
        mAdapter.depositAndBorrowFor(WETH, 1, address(usdc), 1e18);
    }

    function test_Adapter_RepayToIsGeneralAdapter1() public view {
        assertEq(mAdapter.REPAY_TO(), address(ga1));
        assertEq(mAdapter.BORROW_LTV_GAP(), 3e16);
    }

    function test_Usdc_IsSixDecimalsVersion2() public view {
        assertEq(usdc.decimals(), 6);
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USD Coin"), keccak256("2"), block.chainid, address(usdc)
            )
        );
        assertEq(usdc.DOMAIN_SEPARATOR(), expected);
        assertEq(s.transmuter.pairedScale(), SCALE);
    }
}
