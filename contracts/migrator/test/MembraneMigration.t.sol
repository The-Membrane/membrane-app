// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RealWiringFixture} from "membrane/test/RealWiringFixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {Bundler3} from "bundler3/Bundler3.sol";
import {Call} from "bundler3/interfaces/IBundler3.sol";
import {GeneralAdapter1} from "bundler3/adapters/GeneralAdapter1.sol";
import {AaveV3MigrationAdapter} from "bundler3/adapters/migration/AaveV3MigrationAdapter.sol";
import {CoreAdapter} from "bundler3/adapters/CoreAdapter.sol";

import {IMorpho, IMorphoBase, MarketParams, Authorization, Signature, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {AUTHORIZATION_TYPEHASH} from "morpho-blue/libraries/ConstantsLib.sol";

import {Cdp} from "membrane/contracts/Cdp.sol";
import {MembraneBundlerAdapter} from "../src/MembraneBundlerAdapter.sol";
import {MockAaveV3Pool, MockAToken} from "./mocks/MockAaveV3.sol";

/// @notice End-to-end: a real Membrane system (RealWiringFixture: real Cdp, Collateral, Debt,
///         Transmuter peg seam, oracle double) + real Morpho Blue + real Bundler3 / GeneralAdapter1 /
///         AaveV3MigrationAdapter + an Aave V3 pool double. The only Q41 contract is
///         MembraneBundlerAdapter.
contract MembraneMigrationTest is RealWiringFixture {
    using MarketParamsLib for MarketParams;

    IMorpho internal morpho;
    Bundler3 internal bundler;
    GeneralAdapter1 internal ga1;
    AaveV3MigrationAdapter internal aaveAdapter;
    MembraneBundlerAdapter internal mAdapter;
    MockAaveV3Pool internal aave;
    MockAToken internal aWeth;
    MarketParams internal mkt;

    address internal user;
    uint256 internal userPk;
    address internal constant LENDER = address(0x1E4D);
    address internal constant ATTACKER = address(0xBAD);

    uint256 internal constant COLL = 10e18; // 10 WETH @ $2,000 = $20,000
    uint256 internal constant DEBT = 12_000e18; // 60% LTV

    function setUp() public override {
        super.setUp();
        (user, userPk) = makeAddrAndKey("looper");

        // ---- Morpho Blue (real, 0.8.19 artifact) ----
        morpho = IMorpho(deployCode("out/Morpho.sol/Morpho.json", abi.encode(address(this))));
        address irm = deployCode("out/IrmMock.sol/IrmMock.json");
        address mOracle = deployCode("out/OracleMock.sol/OracleMock.json");
        (bool ok,) = mOracle.call(abi.encodeWithSignature("setPrice(uint256)", 2000e36));
        require(ok, "oracle price");
        morpho.enableIrm(irm);
        morpho.enableLltv(0.86e18);
        mkt = MarketParams({loanToken: address(usdc), collateralToken: address(wethToken), oracle: mOracle, irm: irm, lltv: 0.86e18});
        morpho.createMarket(mkt);

        // ---- Bundler3 (real) ----
        bundler = new Bundler3();
        ga1 = new GeneralAdapter1(address(bundler), address(morpho), address(wethToken));
        aave = new MockAaveV3Pool();
        aaveAdapter = new AaveV3MigrationAdapter(address(bundler), address(aave));
        mAdapter = new MembraneBundlerAdapter(address(bundler), address(cdp));

        // ---- Aave double: WETH collateral (LT 86%), USDC debt ----
        aWeth = MockAToken(aave.addReserve(address(wethToken), 2000e18, 8600));
        aave.addReserve(address(usdc), 1e18, 0);

        // ---- liquidity: Morpho USDC (flash source + Morpho market), Aave USDC, Transmuter USDC ----
        vm.startPrank(OWNER);
        usdc.mint(LENDER, 2_000_000e18);
        wethToken.mint(user, 100e18);
        vm.stopPrank();
        vm.startPrank(LENDER);
        usdc.approve(address(morpho), type(uint256).max);
        morpho.supply(mkt, 1_000_000e18, 0, LENDER, "");
        usdc.transfer(address(aave), 500_000e18);
        vm.stopPrank();
        _seedPairedInventory(BOB, WETH, 200_000e18);
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
                user,
                spender,
                value,
                IERC20Permit(token).nonces(user),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return Call({
            to: token,
            data: abi.encodeCall(IERC20Permit.permit, (user, spender, value, deadline, v, r, s)),
            value: 0,
            skipRevert: true, // a front-run permit must not brick the bundle (allowance is then already set)
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

    function _membraneLeg(uint256 pid, uint256 maxBorrowCdt, uint256 flashAmount) internal view returns (Call memory) {
        return _c(
            address(mAdapter),
            abi.encodeCall(
                MembraneBundlerAdapter.depositAndBorrowFor,
                (pid, WETH, maxBorrowCdt, address(usdc), address(ga1), flashAmount)
            )
        );
    }

    function _openAave(uint256 coll, uint256 debt_) internal {
        vm.startPrank(user);
        wethToken.approve(address(aave), coll);
        aave.supply(address(wethToken), coll, user, 0);
        aave.borrow(address(usdc), debt_, 2, 0, user);
        vm.stopPrank();
    }

    function _openMorpho(uint256 coll, uint256 debt_) internal {
        vm.startPrank(user);
        wethToken.approve(address(morpho), coll);
        morpho.supplyCollateral(mkt, coll, user, "");
        morpho.borrow(mkt, debt_, 0, user, user);
        vm.stopPrank();
    }

    /// The Aave bundle, exactly as lib/migrate/bundle.ts builds it.
    function _aaveBundle(uint256 flashAmount, uint256 aTokenPermit, uint256 maxBorrowCdt)
        internal
        view
        returns (Call[] memory outer)
    {
        Call[] memory inner = new Call[](5);
        inner[0] = _c(address(ga1), abi.encodeCall(CoreAdapter.erc20Transfer, (address(usdc), address(aaveAdapter), type(uint256).max)));
        inner[1] = _c(address(aaveAdapter), abi.encodeCall(AaveV3MigrationAdapter.aaveV3Repay, (address(usdc), type(uint256).max, 2, user)));
        inner[2] = _c(address(aaveAdapter), abi.encodeCall(CoreAdapter.erc20Transfer, (address(usdc), address(ga1), type(uint256).max)));
        inner[3] = _c(address(ga1), abi.encodeCall(GeneralAdapter1.erc20TransferFrom, (address(aWeth), address(aaveAdapter), type(uint256).max)));
        inner[4] = _c(address(aaveAdapter), abi.encodeCall(AaveV3MigrationAdapter.aaveV3Withdraw, (address(wethToken), type(uint256).max, address(mAdapter))));
        // the Membrane leg runs inside the callback, after the collateral arrives
        Call[] memory inner2 = new Call[](6);
        for (uint256 i; i < 5; ++i) inner2[i] = inner[i];
        inner2[5] = _membraneLeg(0, maxBorrowCdt, flashAmount);

        outer = new Call[](3);
        outer[0] = _permitCall(address(aWeth), address(ga1), aTokenPermit);
        outer[1] = _permitCall(address(usdc), address(mAdapter), flashAmount);
        outer[2] = _flash(flashAmount, inner2);
    }

    function _morphoBundle(uint256 flashAmount, uint256 maxBorrowCdt) internal view returns (Call[] memory outer) {
        Call[] memory inner = new Call[](3);
        inner[0] = _c(
            address(ga1),
            abi.encodeCall(GeneralAdapter1.morphoRepay, (mkt, 0, type(uint256).max, type(uint256).max, user, bytes("")))
        );
        inner[1] = _c(address(ga1), abi.encodeCall(GeneralAdapter1.morphoWithdrawCollateral, (mkt, type(uint256).max, address(mAdapter))));
        inner[2] = _membraneLeg(0, maxBorrowCdt, flashAmount);
        outer = new Call[](3);
        outer[0] = _morphoAuthCall();
        outer[1] = _permitCall(address(usdc), address(mAdapter), flashAmount);
        outer[2] = _flash(flashAmount, inner);
    }

    function _assertNoResidue() internal view {
        address[3] memory holders = [address(ga1), address(aaveAdapter), address(mAdapter)];
        for (uint256 i; i < 3; ++i) {
            assertEq(usdc.balanceOf(holders[i]), 0, "USDC residue");
            assertEq(wethToken.balanceOf(holders[i]), 0, "WETH residue");
            assertEq(aWeth.balanceOf(holders[i]), 0, "aWETH residue");
            assertEq(cdt.balanceOf(holders[i]), 0, "CDT residue");
        }
    }

    function _onlyPosition() internal view returns (uint256 pid) {
        pid = cdp.userPositionIds(user, 0);
        (, address owner_,,,,) = cdp.position(pid);
        assertEq(owner_, user, "Membrane position owner");
    }

    // ------------------------------------------------------------------ Aave V3

    /// Prompts on a plain EOA: setPositionOperator (tx, once) + aToken permit + USDC permit + multicall (tx).
    function test_AaveMigration_EndToEnd() public {
        _openAave(COLL, DEBT);
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 morphoUsdcBefore = usdc.balanceOf(address(morpho));

        // the debt grows between the read and the signature; the flash amount carries a buffer
        uint256 flash = DEBT + DEBT / 1000;
        aave.accrueDebt(address(usdc), user, 3e18);
        uint256 owed = DEBT + 3e18;

        vm.prank(user);
        cdp.setPositionOperator(address(mAdapter), true); // prompt 1 (tx, one-time)
        Call[] memory bundle = _aaveBundle(flash, COLL + COLL / 1000, (flash * 1e18) / 1e18); // prompts 2-3 (typed data)
        vm.prank(user);
        bundler.multicall(bundle); // prompt 4 (tx)

        // old venue closed
        assertEq(aave.variableDebt(address(usdc), user), 0, "Aave debt repaid");
        assertEq(aWeth.balanceOf(user), 0, "aTokens moved");
        // Membrane position: same collateral, debt == exactly what Aave was owed
        uint256 pid = _onlyPosition();
        assertEq(cdp.positionDebt(pid), owed, "Membrane debt == repaid (no buffer borrowed)");
        assertEq(cdp.positionCollateralValue(pid), 20_000e18, "collateral value moved");
        // no extra capital: the user's USDC balance is unchanged
        assertEq(usdc.balanceOf(user), usdcBefore, "user USDC unchanged");
        // flash fee 0: Morpho holds exactly what it held
        assertEq(usdc.balanceOf(address(morpho)), morphoUsdcBefore, "flash repaid, fee 0");
        _assertNoResidue();
    }

    /// Old LTV above Membrane's borrow cap: the Cdp refuses the reopen and the whole bundle reverts —
    /// the plan (lib/migrate/plan.ts) must trim first. Nothing moves.
    function test_AaveMigration_LtvAboveMembraneCap_Reverts() public {
        uint256 hot = 16_400e18; // 82% of $20,000 — under Aave's 86% LT, over Membrane's line
        _openAave(COLL, hot);
        vm.prank(user);
        cdp.setPositionOperator(address(mAdapter), true);
        uint256 flash = hot + hot / 1000;
        Call[] memory bundle = _aaveBundle(flash, COLL + COLL / 1000, flash);
        vm.prank(user);
        vm.expectRevert(Cdp.InsolventAfterAction.selector);
        bundler.multicall(bundle);
        assertEq(aave.variableDebt(address(usdc), user), hot, "nothing moved");
        assertEq(aWeth.balanceOf(user), COLL, "nothing moved");
    }

    /// Where the Cdp's reopen line sits (fixture WETH max LTV 80%): lib/migrate/plan.ts trims to the
    /// borrow LTV (max − 3pp = 77%). 77% must pass on-chain; 80.1% must not.
    function test_AaveMigration_AtBorrowLtv_Passes() public {
        uint256 d = 15_400e18; // 77.0%
        _openAave(COLL, d);
        vm.prank(user);
        cdp.setPositionOperator(address(mAdapter), true);
        uint256 flash = d + d / 1000;
        Call[] memory bundle = _aaveBundle(flash, COLL + COLL / 1000, flash);
        vm.prank(user);
        bundler.multicall(bundle);
        assertEq(cdp.positionDebt(_onlyPosition()), d);
    }

    function test_AaveMigration_JustAboveMaxLtv_Reverts() public {
        uint256 d = 16_020e18; // 80.1%
        _openAave(COLL, d);
        vm.prank(user);
        cdp.setPositionOperator(address(mAdapter), true);
        uint256 flash = d + d / 1000;
        Call[] memory bundle = _aaveBundle(flash, COLL + COLL / 1000, flash);
        vm.prank(user);
        vm.expectRevert(Cdp.InsolventAfterAction.selector);
        bundler.multicall(bundle);
    }

    function test_AaveMigration_BorrowCapBelowOwed_Reverts() public {
        _openAave(COLL, DEBT);
        vm.prank(user);
        cdp.setPositionOperator(address(mAdapter), true);
        uint256 flash = DEBT + DEBT / 1000;
        Call[] memory bundle = _aaveBundle(flash, COLL + COLL / 1000, DEBT - 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapter.BorrowAboveCap.selector, DEBT, DEBT - 1));
        bundler.multicall(bundle);
    }

    function test_AaveMigration_WithoutOperatorGrant_Reverts() public {
        _openAave(COLL, DEBT);
        uint256 flash = DEBT + DEBT / 1000;
        Call[] memory bundle = _aaveBundle(flash, COLL + COLL / 1000, flash);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapter.NotOperator.selector, user, address(mAdapter)));
        bundler.multicall(bundle);
    }

    // ------------------------------------------------------------------ Morpho Blue

    /// Prompts on a plain EOA: setPositionOperator (tx, once) + Morpho authorization sig + USDC permit + multicall.
    function test_MorphoMigration_EndToEnd() public {
        _openMorpho(COLL, DEBT);
        skip(1 days); // Morpho interest accrues; repay-by-shares closes all of it
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 flash = DEBT + DEBT / 100;

        vm.prank(user);
        cdp.setPositionOperator(address(mAdapter), true);
        Call[] memory bundle = _morphoBundle(flash, flash);
        vm.prank(user);
        bundler.multicall(bundle);

        Id id = mkt.id();
        (, uint128 borrowShares, uint128 collateral_) = _morphoPosition(id, user);
        assertEq(borrowShares, 0, "Morpho debt repaid");
        assertEq(collateral_, 0, "Morpho collateral moved");
        uint256 pid = _onlyPosition();
        assertGt(cdp.positionDebt(pid), DEBT, "Membrane debt includes Morpho interest");
        assertLe(cdp.positionDebt(pid), flash, "never more than the flash amount");
        assertEq(usdc.balanceOf(user), usdcBefore, "user USDC unchanged");
        _assertNoResidue();
    }

    function _morphoPosition(Id id, address who) internal view returns (uint256, uint128, uint128) {
        (uint256 s, uint128 b, uint128 c) = _pos(id, who);
        return (s, b, c);
    }

    function _pos(Id id, address who) internal view returns (uint256 s, uint128 b, uint128 c) {
        (bool ok, bytes memory ret) = address(morpho).staticcall(abi.encodeWithSignature("position(bytes32,address)", id, who));
        require(ok, "position");
        (s, b, c) = abi.decode(ret, (uint256, uint128, uint128));
    }

    // ------------------------------------------------------------------ security

    /// WHY THE ADAPTER EXISTS: if a user made Bundler3 itself their Cdp operator, anyone could
    /// borrow against their position through a bundle of their own.
    function test_Reason_Bundler3AsOperatorLetsAnyoneBorrow() public {
        vm.startPrank(user);
        wethToken.approve(address(cdp), COLL);
        uint256 pid = cdp.deposit(0, user, _funds(WETH, COLL));
        cdp.setPositionOperator(address(bundler), true);
        vm.stopPrank();
        Call[] memory evil = new Call[](1);
        evil[0] = _c(address(cdp), abi.encodeWithSignature("increaseDebt(uint256,bytes32,uint256)", pid, WETH, 15_000e18));
        vm.prank(ATTACKER);
        bundler.multicall(evil);
        assertEq(cdp.positionDebt(pid), 15_000e18, "attacker pushed the victim's debt to the cap");
    }

    /// The adapter acts only for the bundle's initiator: a victim's grant does not help an attacker.
    function test_Adapter_AttackerCannotBorrowForVictim() public {
        vm.startPrank(user);
        wethToken.approve(address(cdp), COLL);
        uint256 pid = cdp.deposit(0, user, _funds(WETH, COLL));
        cdp.setPositionOperator(address(mAdapter), true);
        vm.stopPrank();
        vm.prank(OWNER);
        wethToken.mint(ATTACKER, 1e18);
        vm.prank(ATTACKER);
        wethToken.transfer(address(mAdapter), 1e18);
        Call[] memory evil = new Call[](1);
        evil[0] = _membraneLeg(pid, type(uint256).max, 10_000e18);
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapter.NotOperator.selector, ATTACKER, address(mAdapter)));
        bundler.multicall(evil);
        assertEq(cdp.positionDebt(pid), 0);
    }

    function test_Adapter_RejectsDirectCalls() public {
        vm.expectRevert(MembraneBundlerAdapter.UnauthorizedSender.selector);
        mAdapter.depositAndBorrowFor(0, WETH, 1, address(usdc), address(ga1), 1);
    }

    function test_Adapter_RejectsSomeoneElsesPosition() public {
        vm.startPrank(BOB);
        uint256 bobPid = cdp.deposit(0, BOB, _funds(WETH, 1e18));
        vm.stopPrank();
        vm.prank(user);
        cdp.setPositionOperator(address(mAdapter), true);
        Call[] memory b = new Call[](1);
        b[0] = _membraneLeg(bobPid, type(uint256).max, 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MembraneBundlerAdapter.NotPositionOwner.selector, user, bobPid, BOB));
        bundler.multicall(b);
    }
}
