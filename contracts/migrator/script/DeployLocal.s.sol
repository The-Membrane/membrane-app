// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RW_Oracle, RW_DiscoLtv} from "membrane/test/RealWiringFixture.sol";
import {Cdp} from "membrane/contracts/Cdp.sol";
import {CdpInternal} from "membrane/contracts/lib/CdpInternal.sol";
import {Collateral} from "membrane/contracts/Collateral.sol";
import {Debt} from "membrane/contracts/Debt.sol";
import {SystemDiscounts} from "membrane/contracts/SystemDiscounts.sol";
import {MembraneToken} from "membrane/contracts/lib/Tokenfactory.sol";
import {MembraneConstants} from "membrane/contracts/lib/Constants.sol";
import {LiquidationEngine} from "membrane/contracts/LiquidationEngine.sol";
import {Auction} from "membrane/contracts/Auction.sol";
import {LtvDisco} from "membrane/contracts/LtvDisco.sol";
import {Transmuter} from "membrane/contracts/Transmuter.sol";
import {CapController} from "membrane/contracts/CapController.sol";
import {RevenueDistributor} from "membrane/contracts/RevenueDistributor.sol";
import {FounderRevenue} from "membrane/contracts/FounderRevenue.sol";

import {Bundler3} from "bundler3/Bundler3.sol";
import {GeneralAdapter1} from "bundler3/adapters/GeneralAdapter1.sol";
import {AaveV3MigrationAdapter} from "bundler3/adapters/migration/AaveV3MigrationAdapter.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";

import {MembraneBundlerAdapter} from "../src/MembraneBundlerAdapter.sol";
import {MockAaveV3Pool} from "../test/mocks/MockAaveV3.sol";

/// @notice LOCAL ANVIL ONLY. Stands up the self-contained migration stack the app's dev page and
///         tests/e2e anvil run use: Membrane exactly as RealWiringFixture wires it (real Cdp,
///         Collateral, Debt, Transmuter with the peg seam WIRED — DeployFullSystem does not wire
///         it), real Morpho Blue, real Bundler3 + GeneralAdapter1 + AaveV3MigrationAdapter, an Aave
///         V3 pool double, and MembraneBundlerAdapter. Seeds three anvil accounts with positions.
///
///   anvil --disable-code-size-limit ; forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 \
///     --broadcast --slow --disable-code-size-limit
///
/// Writes deployments/local.json.
contract DeployLocal is Script {
    // anvil default accounts (public test keys)
    uint256 constant PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // deployer / owner
    uint256 constant PK2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a; // Aave looper
    uint256 constant PK3 = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6; // Morpho looper
    uint256 constant PK4 = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a; // Aave, over the line
    address constant GOV = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // anvil #1
    address constant FOUNDER = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc; // anvil #5

    bytes32 constant WETH = bytes32("WETH");
    bytes32 constant CDT_DENOM = bytes32("CDT");

    struct S {
        MembraneToken cdt;
        MembraneToken mbrn;
        MembraneToken weth;
        MembraneToken usdc;
        RW_Oracle oracle;
        RW_DiscoLtv discoLtv;
        Collateral collateral;
        RevenueDistributor revdist;
        SystemDiscounts discounts;
        Debt debt;
        Cdp cdp;
        Auction auction;
        LiquidationEngine engine;
        LtvDisco disco;
        Transmuter transmuter;
        CapController capController;
        IMorpho morpho;
        MarketParams mkt;
        Bundler3 bundler;
        GeneralAdapter1 ga1;
        AaveV3MigrationAdapter aaveAdapter;
        MockAaveV3Pool aave;
        MembraneBundlerAdapter mAdapter;
    }

    function run() external {
        address owner = vm.addr(PK0);
        S memory s;
        vm.startBroadcast(PK0);
        _membrane(s, owner);
        _venues(s, owner);
        _seedLiquidity(s, owner);
        vm.stopBroadcast();
        _seedPositions(s);
        _write(s);
    }

    function _membrane(S memory s, address owner) internal {
        s.cdt = new MembraneToken("Membrane CDT", "CDT", owner);
        s.mbrn = new MembraneToken("Membrane MBRN", "MBRN", owner);
        s.weth = new MembraneToken("Wrapped Ether", "WETH", owner);
        s.usdc = new MembraneToken("USD Coin", "USDC", owner);
        s.oracle = new RW_Oracle();
        s.oracle.setPrice(WETH, 2000e18);
        s.oracle.setPrice(CDT_DENOM, 1e18);
        s.discoLtv = new RW_DiscoLtv();
        s.discoLtv.setLtv(WETH, 80e16);

        Collateral.AssetParams[] memory genesis = new Collateral.AssetParams[](1);
        genesis[0].denom = WETH;
        genesis[0].temp_ltv = 80e16;
        genesis[0].max_threshold_to_delay = 4e16;
        genesis[0].oracle_source = address(s.oracle);
        genesis[0].enabled = true;
        s.collateral = new Collateral(owner, GOV, genesis);

        FounderRevenue founderRevenue = new FounderRevenue(FOUNDER);
        RevenueDistributor.RevenueSplit memory split = RevenueDistributor.RevenueSplit({
            disco_ratio: 20e16,
            junior_ratio: 64e16,
            senior_ratio: 16e16,
            reserve_ratio: 0
        });
        s.revdist = new RevenueDistributor(
            owner, GOV, IERC20(address(s.cdt)), split, address(founderRevenue),
            uint64(block.timestamp) + MembraneConstants.FOUNDER_VEST_DURATION_S
        );
        s.discounts = new SystemDiscounts(owner, GOV);

        address predictedCdp = vm.computeCreateAddress(owner, vm.getNonce(owner) + 1);
        Debt.Basket memory basket = Debt.Basket({
            cdt_minted: 0,
            pending_revenue: 0,
            debt_cap: 1_000_000_000e18,
            base_interest_rate: 1e17,
            last_accrued: uint64(block.timestamp),
            circuit_breaker: false,
            distribute_revenue: true
        });
        s.debt = new Debt(owner, GOV, predictedCdp, IERC20(address(s.cdt)), basket, 1e17);

        Cdp.ConstructorParams memory cp;
        cp.owner = owner;
        cp.governance = GOV;
        cp.collateral = address(s.collateral);
        cp.debtContract = address(s.debt);
        cp.systemDiscounts = address(s.discounts);
        cp.oracle = address(s.oracle);
        cp.liqFee = 1e16;
        cp.affiliateFeeMax = 1e16;
        cp.debtMinimum = 1;
        cp.liquidationStatLimit = 100;
        cp.baseInterestRate = 1e17;
        cp.maxAdaptiveRate = 2e18;
        s.cdp = new Cdp(cp);
        require(address(s.cdp) == predictedCdp, "cdp prediction");

        s.auction = new Auction(
            owner, GOV, IERC20(address(s.cdt)),
            Auction.Config({
                mbrnDenom: bytes32("MBRN"),
                cdtDenom: CDT_DENOM,
                desiredAsset: bytes32("MBRN"),
                positionsContract: address(s.cdp),
                stakingContract: address(0),
                twapTimeframeM: 60,
                initialDiscount: 1e16,
                discountIncreaseTimeframeS: 36,
                discountIncrease: 1e16,
                sendToStakers: false,
                delayWindowM: 60
            })
        );
        s.engine = new LiquidationEngine(owner, GOV, 1e16, 8 hours, CDT_DENOM);
        s.disco = new LtvDisco(
            owner, GOV, IERC20(address(s.mbrn)), IERC20(address(s.cdt)),
            LtvDisco.Config({
                minimumDeposit: 0,
                unstakingPeriod: 7 days,
                unstakeExecutionWindow: 2 days,
                ltvSwitchingPeriod: 7 days,
                ltvSwitchingExecutionWindow: 2 days,
                managerFeeChangePeriod: 7 days,
                managerFeeChangeExecutionWindow: 2 days,
                affiliateFee: 1e16,
                maxManagementFee: 1e18
            })
        );
        s.transmuter = new Transmuter(
            owner, GOV,
            Transmuter.TConfig({
                discounts_contract: address(s.discounts),
                cdp_contract: address(s.cdp),
                collateral_contract: address(s.collateral),
                acquisition_contract: address(0),
                revenue_distributor: address(s.revdist),
                cdt_denom: CDT_DENOM,
                paired_asset_denom: bytes32("USDC"),
                usage_fee: 1e16,
                affiliate_fee: 1e16,
                send_swap_fee: false,
                revenue_distributor_fee_percentage: 1e17,
                max_management_fee: 2e17,
                switching_period: 14 days,
                switching_execution_window: 2 days
            }),
            IERC20(address(s.cdt)), IERC20(address(s.usdc))
        );
        s.capController = new CapController(address(s.transmuter));

        s.cdt.grantRole(s.cdt.MINTER_ROLE(), address(s.debt));
        s.cdt.grantRole(s.cdt.BURNER_ROLE(), address(s.cdp));
        s.cdt.grantRole(s.cdt.BURNER_ROLE(), address(s.debt));
        s.cdt.grantRole(s.cdt.BURNER_ROLE(), address(s.revdist));
        s.weth.grantRole(s.weth.MINTER_ROLE(), owner);
        s.usdc.grantRole(s.usdc.MINTER_ROLE(), owner);

        s.collateral.initialize(address(0), address(s.disco));
        s.debt.initialize(address(s.auction), address(s.revdist));
        s.revdist.initialize(address(s.cdp), address(0), address(0));
        s.revdist.setDiscoExcessYield(address(s.disco));
        s.revdist.setTransmuter(address(s.transmuter));
        s.cdp.initialize(
            address(s.auction), address(s.engine), address(s.disco), address(s.oracle),
            address(s.revdist), address(s.transmuter), address(s.transmuter)
        );
        s.cdp.registerSupplyCap(WETH, type(uint128).max);
        s.cdp.setAssetToken(WETH, address(s.weth));
        address[] memory quoteTokens = new address[](0);
        s.disco.initialize(
            address(0), address(s.auction), address(s.cdp), address(0), address(0), address(s.engine),
            address(0), address(0), quoteTokens, address(s.revdist), address(0), address(0)
        );
        s.transmuter.initialize(address(s.disco), address(s.capController));
        // The one wiring DeployFullSystem.s.sol omits: without it every peg borrow reverts.
        s.cdp.setTransmuterForPeg(address(s.transmuter));
    }

    function _venues(S memory s, address owner) internal {
        s.morpho = IMorpho(deployCode("out/Morpho.sol/Morpho.json", abi.encode(owner)));
        address irm = deployCode("out/IrmMock.sol/IrmMock.json");
        address mOracle = deployCode("out/OracleMock.sol/OracleMock.json");
        (bool ok,) = mOracle.call(abi.encodeWithSignature("setPrice(uint256)", 2000e36));
        require(ok, "oracle");
        s.morpho.enableIrm(irm);
        s.morpho.enableLltv(0.86e18);
        s.mkt = MarketParams({loanToken: address(s.usdc), collateralToken: address(s.weth), oracle: mOracle, irm: irm, lltv: 0.86e18});
        s.morpho.createMarket(s.mkt);

        s.bundler = new Bundler3();
        s.ga1 = new GeneralAdapter1(address(s.bundler), address(s.morpho), address(s.weth));
        s.aave = new MockAaveV3Pool();
        s.aaveAdapter = new AaveV3MigrationAdapter(address(s.bundler), address(s.aave));
        s.mAdapter = new MembraneBundlerAdapter(address(s.bundler), address(s.cdp));
        s.aave.addReserve(address(s.weth), 2000e18, 8600);
        s.aave.addReserve(address(s.usdc), 1e18, 0);
    }

    function _seedLiquidity(S memory s, address owner) internal {
        s.usdc.mint(owner, 3_000_000e18);
        s.usdc.approve(address(s.morpho), type(uint256).max);
        s.morpho.supply(s.mkt, 1_000_000e18, 0, owner, "");
        s.usdc.transfer(address(s.aave), 500_000e18);
        // Transmuter USDC inventory through the real senior-tranche entry
        s.usdc.approve(address(s.transmuter), 200_000e18);
        bytes32[] memory assets = new bytes32[](1);
        bool[] memory juniors = new bool[](1);
        uint256[] memory amounts = new uint256[](1);
        assets[0] = WETH;
        amounts[0] = 200_000e18;
        s.transmuter.enterVault(owner, 0, 200_000e18, assets, juniors, amounts, bytes32(0));
        s.weth.mint(vm.addr(PK2), 20e18);
        s.weth.mint(vm.addr(PK3), 20e18);
        s.weth.mint(vm.addr(PK4), 20e18);
    }

    function _seedPositions(S memory s) internal {
        // #2: Aave 10 WETH / 12,000 USDC (60%)
        vm.startBroadcast(PK2);
        s.weth.approve(address(s.aave), 10e18);
        s.aave.supply(address(s.weth), 10e18, vm.addr(PK2), 0);
        s.aave.borrow(address(s.usdc), 12_000e18, 2, 0, vm.addr(PK2));
        vm.stopBroadcast();
        // #3: Morpho 10 WETH / 12,000 USDC
        vm.startBroadcast(PK3);
        s.weth.approve(address(s.morpho), 10e18);
        s.morpho.supplyCollateral(s.mkt, 10e18, vm.addr(PK3), "");
        s.morpho.borrow(s.mkt, 12_000e18, 0, vm.addr(PK3), vm.addr(PK3));
        vm.stopBroadcast();
        // #4: Aave 10 WETH / 16,400 USDC (82%) — over Membrane's borrow LTV
        vm.startBroadcast(PK4);
        s.weth.approve(address(s.aave), 10e18);
        s.aave.supply(address(s.weth), 10e18, vm.addr(PK4), 0);
        s.aave.borrow(address(s.usdc), 16_400e18, 2, 0, vm.addr(PK4));
        vm.stopBroadcast();
    }

    function _write(S memory s) internal {
        string memory k = "local";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "bundler3", address(s.bundler));
        vm.serializeAddress(k, "generalAdapter1", address(s.ga1));
        vm.serializeAddress(k, "aaveV3Adapter", address(s.aaveAdapter));
        vm.serializeAddress(k, "morpho", address(s.morpho));
        vm.serializeAddress(k, "morphoOracle", s.mkt.oracle);
        vm.serializeAddress(k, "morphoIrm", s.mkt.irm);
        vm.serializeUint(k, "morphoLltv", s.mkt.lltv);
        vm.serializeAddress(k, "aavePool", address(s.aave));
        vm.serializeAddress(k, "cdp", address(s.cdp));
        vm.serializeAddress(k, "transmuter", address(s.transmuter));
        vm.serializeAddress(k, "membraneAdapter", address(s.mAdapter));
        vm.serializeAddress(k, "usdc", address(s.usdc));
        vm.serializeAddress(k, "cdt", address(s.cdt));
        vm.serializeAddress(k, "weth", address(s.weth));
        vm.serializeAddress(k, "oracle", address(s.oracle));
        vm.serializeAddress(k, "aaveLooper", vm.addr(PK2));
        vm.serializeAddress(k, "morphoLooper", vm.addr(PK3));
        vm.serializeAddress(k, "hotLooper", vm.addr(PK4));
        string memory json = vm.serializeBytes32(k, "wethDenom", WETH);
        vm.writeJson(json, "deployments/local.json");
        console2.log("wrote deployments/local.json");
    }
}
