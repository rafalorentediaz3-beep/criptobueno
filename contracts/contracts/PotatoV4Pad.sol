// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PotatoToken} from "./PotatoToken.sol";
import {PotatoV4FeeLocker} from "./PotatoV4FeeLocker.sol";
import {PotatoV4TokenFactory} from "./PotatoV4TokenFactory.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {
    IUniswapV4PoolManager,
    IUniswapV4PositionManager,
    IWETH9V4
} from "./interfaces/IUniswapV4.sol";

interface IPermit2Approval {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title PotatoV4Pad
/// @notice Optional direct-to-Uniswap-v4 launcher. PotatoCurvePad remains the
/// primary v3 launcher; this contract is an independent deployment and does not
/// change any existing v3 pool or token.
contract PotatoV4Pad is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant MAX_WALLET = TOTAL_SUPPLY / 50;
    uint256 public constant MAX_SALT_TRIES = 64;
    uint256 private constant Q96 = 1 << 96;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable treasury;
    uint256 public immutable startFdv;
    uint256 public immutable antiSnipeBlocks;
    IUniswapV4PoolManager public immutable poolManager;
    IUniswapV4PositionManager public immutable positionManager;
    IERC20 public immutable weth;
    /// @dev Stored for deployment/config introspection. PositionManager uses
    /// Permit2 internally; this pad deliberately settles from its own balance.
    address public immutable permit2;
    PotatoV4FeeLocker public immutable locker;
    PotatoV4TokenFactory public immutable tokenFactory;
    address public immutable owner;

    struct TokenMeta {
        string imageURI;
        string website;
        string twitter;
        string telegram;
    }

    struct V4Info {
        address creator;
        bytes32 poolId;
        uint256 positionId;
        uint24 fee;
    }

    mapping(address => V4Info) public v4Tokens;
    mapping(bytes32 => bool) public banned;

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        address pool,
        string imageURI,
        string website,
        string twitter,
        string telegram
    );
    event V4PoolCreated(
        address indexed token,
        bytes32 indexed poolId,
        uint24 fee,
        int24 tickSpacing,
        uint256 positionId
    );
    event BannedSet(bytes32 indexed wordHash, bool banned);
    event DevBuy(address indexed token, address indexed buyer, uint256 wethSpent, uint256 tokensOut);

    error InvalidConfig();
    error InvalidFee();
    error InvalidSalt();
    error LaunchGriefed();
    error BannedName();
    error OnlyOwner();
    error LiquidityOverflow();
    error OnlyPoolManager();
    error DevBuyExceedsCap();
    error EthTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(
        address treasury_,
        uint256 startFdv_,
        uint256 antiSnipeBlocks_,
        IUniswapV4PoolManager poolManager_,
        IUniswapV4PositionManager positionManager_,
        IERC20 weth_,
        address permit2_,
        address owner_,
        string[] memory initialBannedWords_
    ) {
        if (
            treasury_ == address(0) || startFdv_ == 0 || address(poolManager_) == address(0)
                || address(positionManager_) == address(0) || address(weth_) == address(0)
                || permit2_ == address(0) || owner_ == address(0)
        ) revert InvalidConfig();
        treasury = treasury_;
        startFdv = startFdv_;
        antiSnipeBlocks = antiSnipeBlocks_;
        poolManager = poolManager_;
        positionManager = positionManager_;
        weth = weth_;
        permit2 = permit2_;
        owner = owner_;
        locker = new PotatoV4FeeLocker(positionManager_, IWETH9V4(address(weth_)), treasury_);
        tokenFactory = new PotatoV4TokenFactory(
            address(positionManager_), address(locker), TOTAL_SUPPLY, MAX_WALLET, antiSnipeBlocks_
        );
        for (uint256 i; i < initialBannedWords_.length; ++i) {
            banned[_normHash(bytes(initialBannedWords_[i]))] = true;
        }
    }

    /// @notice Launches a fixed-supply v4 position. The initial LP position is
    /// always single-sided (100% token, zero WETH), so a token can always be
    /// launched with no ETH. Supported trading fees are 0.01%, 0.05%, 0.30%,
    /// and 1.00%.
    /// @dev msg.value is an OPTIONAL dev buy: if non-zero, it is swapped for
    /// the freshly-seeded token right after the position is minted, exactly
    /// like the v3 curve pad's dev buy. It is never required to launch.
    function createToken(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt,
        uint24 fee
    ) external payable nonReentrant returns (address token) {
        int24 tickSpacing = tickSpacingForFee(fee);
        if (banned[_normHashCalldata(name)] || banned[_normHashCalldata(symbol)]) {
            revert BannedName();
        }

        bytes32 initCodeHash = tokenFactory.initCodeHash(name, symbol);
        uint256 seed = uint256(keccak256(abi.encode(msg.sender, salt)));
        address predicted;
        uint256 tries;
        for (; tries < MAX_SALT_TRIES;) {
            predicted = _computeTokenAddress(bytes32(seed + tries), initCodeHash);
            if (predicted.code.length == 0) break;
            unchecked {
                ++tries;
            }
        }
        if (tries == MAX_SALT_TRIES) revert LaunchGriefed();
        token = tokenFactory.deploy(name, symbol, bytes32(seed + tries));
        if (token != predicted) revert InvalidSalt();

        PotatoToken(token).setPool(address(poolManager));
        bool tokenIs0 = token < address(weth);
        int24 floor = _alignToSpacing(
            TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(startFdv)), tickSpacing
        );
        int24 minTick = (TickMath.MIN_TICK / tickSpacing) * tickSpacing;
        int24 maxTick = (TickMath.MAX_TICK / tickSpacing) * tickSpacing;
        // Single-sided range, same shape as the v3 curve pad's `_rangeFor`:
        // the position covers the opening tick through the far edge of the
        // tick space, seeded entirely from the token side. The current price
        // sits exactly at the near edge of the range (`center`), so the
        // position never needs any WETH to mint — a dev buy is a separate,
        // optional swap executed after the mint below.
        int24 lower = tokenIs0 ? floor : minTick;
        int24 upper = tokenIs0 ? maxTick : -floor;
        int24 center = tokenIs0 ? lower : upper;
        uint160 sqrtPrice = TickMath.getSqrtRatioAtTick(center);

        IUniswapV4PoolManager.PoolKey memory key = IUniswapV4PoolManager.PoolKey({
            currency0: tokenIs0 ? token : address(weth),
            currency1: tokenIs0 ? address(weth) : token,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: address(0)
        });
        poolManager.initialize(key, sqrtPrice);

        uint160 sqrtLower = TickMath.getSqrtRatioAtTick(lower);
        uint160 sqrtUpper = TickMath.getSqrtRatioAtTick(upper);
        // The current price equals sqrtLower (tokenIs0) or sqrtUpper
        // (!tokenIs0), so only ONE side of the standard liquidity formula is
        // needed — the other side's required amount is exactly zero.
        uint256 liquidity = tokenIs0
            ? Math.mulDiv(
                TOTAL_SUPPLY, Math.mulDiv(sqrtLower, sqrtUpper, Q96), uint256(sqrtUpper) - sqrtLower
            )
            : Math.mulDiv(TOTAL_SUPPLY, Q96, uint256(sqrtUpper) - sqrtLower);
        if (liquidity == 0 || liquidity > type(uint128).max) revert LiquidityOverflow();

        // Authorize the PositionManager to pull the freshly minted supply through
        // Permit2. This is the standard v4 settlement path used by Robinhood's
        // deployed PositionManager and avoids relying on a pre-funded balance.
        bool hasPermit2 = permit2.code.length != 0;
        if (hasPermit2) {
            IERC20(token).approve(permit2, type(uint256).max);
            IPermit2Approval(permit2).approve(
                token, address(positionManager), type(uint160).max, type(uint48).max
            );
        } else {
            // Local test doubles do not deploy Permit2; retain their pre-funded
            // settlement path without weakening the live Robinhood path.
            IERC20(token).safeTransfer(address(positionManager), TOTAL_SUPPLY);
        }
        uint256 positionId = positionManager.nextTokenId();
        // A mint leaves the PoolManager with a negative delta for the token
        // side only (the WETH side is zero for this single-sided position).
        // SETTLE_PAIR/SETTLE still resolve both currencies; settling zero for
        // WETH is a no-op.
        bytes memory actions = hasPermit2
            ? abi.encodePacked(bytes1(uint8(0x02)), bytes1(uint8(0x0d)), bytes1(uint8(0x14)))
            : abi.encodePacked(bytes1(uint8(0x02)), bytes1(uint8(0x0b)), bytes1(uint8(0x0b)), bytes1(uint8(0x14)));
        bytes[] memory params = new bytes[](hasPermit2 ? 3 : 4);
        params[0] = abi.encode(
            key,
            lower,
            upper,
            liquidity,
            // These are maximum amounts accepted by the PositionManager, not
            // mint amounts. Rounding at an extreme tick can make the exact
            // required amount one unit above TOTAL_SUPPLY; use the uint128
            // ceiling while the freshly minted token balance remains the
            // actual funding source.
            type(uint128).max,
            type(uint128).max,
            address(locker),
            bytes("")
        );
        if (hasPermit2) {
            params[1] = abi.encode(key.currency0, key.currency1);
            params[2] = abi.encode(token, DEAD);
        } else {
            uint256 contractBalance = 1 << 255;
            params[1] = abi.encode(key.currency0, contractBalance, false);
            params[2] = abi.encode(key.currency1, contractBalance, false);
            params[3] = abi.encode(token, DEAD);
        }
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        uint256 leftoverToken = IERC20(token).balanceOf(address(this));
        if (leftoverToken != 0) IERC20(token).safeTransfer(DEAD, leftoverToken);
        locker.register(positionId, token, msg.sender, key.currency0, key.currency1);

        bytes32 poolId = keccak256(abi.encode(key));
        v4Tokens[token] = V4Info(msg.sender, poolId, positionId, fee);
        emit TokenCreated(
            token, msg.sender, name, symbol, address(0), meta.imageURI, meta.website, meta.twitter, meta.telegram
        );
        emit V4PoolCreated(token, poolId, fee, tickSpacing, positionId);

        // Optional dev buy: only runs if the creator sent ETH. Never blocks
        // the launch itself.
        if (msg.value > 0) {
            _devBuy(token, key, tokenIs0, lower, upper, tickSpacing);
        }
    }

    /// @dev Swaps `msg.value` ETH for the just-seeded token directly against
    /// the live PoolManager, mirroring the v3 curve pad's `_devBuy`. Runs
    /// after the position mint above so the pool already has liquidity to
    /// fill the swap against. Reverts (refunding nothing) if it fails, which
    /// only rolls back the dev buy attempt — callers that want a
    /// launch-cannot-fail guarantee should keep msg.value at 0.
    function _devBuy(
        address token,
        IUniswapV4PoolManager.PoolKey memory key,
        bool tokenIs0,
        int24 lower,
        int24 upper,
        int24 tickSpacing
    ) internal {
        IWETH9V4(address(weth)).deposit{value: msg.value}();
        bool zeroForOne = !tokenIs0;
        // Cap the swap one tick-spacing short of the seeded range's far edge
        // so it can never touch TickMath's absolute min/max sqrt ratio.
        uint160 sqrtPriceLimitX96 = tokenIs0
            ? TickMath.getSqrtRatioAtTick(upper - tickSpacing)
            : TickMath.getSqrtRatioAtTick(lower + tickSpacing);

        poolManager.unlock(
            abi.encode(key, zeroForOne, msg.value, sqrtPriceLimitX96, token, msg.sender)
        );
    }

    /// @notice PoolManager callback for the dev-buy swap kicked off by
    /// `_devBuy`. Not reentrant-guarded on its own because it only ever runs
    /// nested inside `createToken`, which already holds the guard.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (
            IUniswapV4PoolManager.PoolKey memory key,
            bool zeroForOne,
            uint256 wethIn,
            uint160 sqrtPriceLimitX96,
            address token,
            address buyer
        ) = abi.decode(
            data, (IUniswapV4PoolManager.PoolKey, bool, uint256, uint160, address, address)
        );

        int256 delta = poolManager.swap(
            key,
            IUniswapV4PoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(wethIn),
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            bytes("")
        );
        int128 delta0 = _deltaAmount0(delta);
        int128 delta1 = _deltaAmount1(delta);
        bool tokenIs0 = !zeroForOne;
        int128 wethDelta = tokenIs0 ? delta1 : delta0;
        int128 tokenDelta = tokenIs0 ? delta0 : delta1;

        uint256 wethSpent = wethDelta < 0 ? uint256(uint128(-wethDelta)) : 0;
        uint256 tokensOut = tokenDelta > 0 ? uint256(uint128(tokenDelta)) : 0;

        if (
            block.number <= PotatoToken(token).antiSnipeDeadlineBlock()
                && tokensOut > MAX_WALLET
        ) revert DevBuyExceedsCap();

        if (wethSpent != 0) {
            address wethCurrency = tokenIs0 ? key.currency1 : key.currency0;
            poolManager.sync(wethCurrency);
            IERC20(address(weth)).safeTransfer(address(poolManager), wethSpent);
            poolManager.settle();
        }
        if (tokensOut != 0) {
            poolManager.take(token, buyer, tokensOut);
        }
        emit DevBuy(token, buyer, wethSpent, tokensOut);

        uint256 refund = wethIn - wethSpent;
        if (refund != 0) {
            IWETH9V4(address(weth)).withdraw(refund);
            (bool ok,) = buyer.call{value: refund}("");
            if (!ok) revert EthTransferFailed();
        }
        return bytes("");
    }

    /// @dev Unpacks the high 128 bits of a packed v4 `BalanceDelta`.
    function _deltaAmount0(int256 delta) private pure returns (int128 amount0) {
        assembly ("memory-safe") {
            amount0 := sar(128, delta)
        }
    }

    /// @dev Unpacks the low 128 bits of a packed v4 `BalanceDelta`.
    function _deltaAmount1(int256 delta) private pure returns (int128 amount1) {
        assembly ("memory-safe") {
            amount1 := signextend(15, delta)
        }
    }

    /// @notice Allows this contract to receive ETH refunds when unwrapping
    /// WETH during an unspent dev-buy refund.
    receive() external payable {}

    function tickSpacingForFee(uint24 fee) public pure returns (int24) {
        if (fee == 100) return 1; // 0.01%
        if (fee == 500) return 10; // 0.05%
        if (fee == 3_000) return 60; // 0.30%
        if (fee == 10_000) return 200; // 1.00%
        revert InvalidFee();
    }

    function _computeTokenAddress(bytes32 salt, bytes32 initCodeHash)
        internal
        view
        returns (address)
    {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(tokenFactory), salt, initCodeHash))))
        );
    }

    function _sqrtPriceX96FromFdv(uint256 fdv) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(fdv, 1 << 192, TOTAL_SUPPLY)));
    }

    function _alignToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 q = tick / spacing;
        int24 r = tick % spacing;
        if (r >= spacing / 2) ++q;
        else if (r <= -spacing / 2) --q;
        return q * spacing;
    }

    function _normHash(bytes memory b) internal pure returns (bytes32) {
        uint256 len = b.length;
        uint256 start;
        while (start < len && b[start] == 0x20) ++start;
        uint256 end = len;
        while (end > start && b[end - 1] == 0x20) --end;
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) c = bytes1(uint8(c) + 32);
            out[i - start] = c;
        }
        return keccak256(out);
    }

    /// @dev Avoids copying launch calldata into a second memory buffer before
    /// checking the anti-vampire list. This is on the hot launch path.
    function _normHashCalldata(string calldata value) internal pure returns (bytes32) {
        bytes calldata b = bytes(value);
        uint256 len = b.length;
        uint256 start;
        while (start < len && b[start] == 0x20) ++start;
        uint256 end = len;
        while (end > start && b[end - 1] == 0x20) --end;
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) c = bytes1(uint8(c) + 32);
            out[i - start] = c;
        }
        return keccak256(out);
    }

    function setBanned(string calldata word, bool isBanned) external onlyOwner {
        bytes32 h = _normHashCalldata(word);
        banned[h] = isBanned;
        emit BannedSet(h, isBanned);
    }
}
