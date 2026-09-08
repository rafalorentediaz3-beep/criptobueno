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

    error InvalidConfig();
    error InvalidFee();
    error InvalidSalt();
    error LaunchGriefed();
    error BannedName();
    error OnlyOwner();
    error DevBuyUnsupported();
    error LiquidityOverflow();

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

    /// @notice Launches a fixed-supply single-sided v4 position. Supported
    /// trading fees are 0.01%, 0.05%, 0.30%, and 1.00%.
    /// @dev v4 launch does not include a dev-buy: swapping requires the
    /// UniversalRouter and is intentionally a separate user transaction.
    function createToken(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt,
        uint24 fee
    ) external payable nonReentrant returns (address token) {
        if (msg.value != 0) revert DevBuyUnsupported();
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
        int24 lower = tokenIs0 ? floor : minTick;
        int24 upper = tokenIs0 ? maxTick : -floor;
        uint160 sqrtPrice = TickMath.getSqrtRatioAtTick(tokenIs0 ? floor : -floor);

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
        uint256 liquidity;
        if (tokenIs0) {
            uint256 intermediate = Math.mulDiv(sqrtLower, sqrtUpper, Q96);
            liquidity = Math.mulDiv(TOTAL_SUPPLY, intermediate, uint256(sqrtUpper) - sqrtLower);
        } else {
            liquidity = Math.mulDiv(TOTAL_SUPPLY, Q96, uint256(sqrtUpper) - sqrtLower);
        }
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
        // A mint leaves the PoolManager with a negative delta for each currency
        // used by the position. SETTLE_PAIR resolves both through Permit2.
        bytes memory actions = hasPermit2
            ? abi.encodePacked(bytes1(uint8(0x02)), bytes1(uint8(0x0d)), bytes1(uint8(0x14)))
            : abi.encodePacked(bytes1(uint8(0x02)), bytes1(uint8(0x0b)), bytes1(uint8(0x0b)), bytes1(uint8(0x14)));
        bytes[] memory params = new bytes[](hasPermit2 ? 3 : 4);
        params[0] = abi.encode(
            key,
            lower,
            upper,
            liquidity,
            tokenIs0 ? uint128(TOTAL_SUPPLY) : uint128(0),
            tokenIs0 ? uint128(0) : uint128(TOTAL_SUPPLY),
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
        locker.register(positionId, token, msg.sender, key.currency0, key.currency1);

        bytes32 poolId = keccak256(abi.encode(key));
        v4Tokens[token] = V4Info(msg.sender, poolId, positionId, fee);
        emit TokenCreated(
            token, msg.sender, name, symbol, address(0), meta.imageURI, meta.website, meta.twitter, meta.telegram
        );
        emit V4PoolCreated(token, poolId, fee, tickSpacing, positionId);
    }

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
