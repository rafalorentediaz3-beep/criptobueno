// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV4PositionManager, IWETH9V4} from "./interfaces/IUniswapV4.sol";

/// @title PotatoV4FeeLocker
/// @notice Holds a Uniswap v4 position NFT permanently and exposes only fee
/// collection. The NFT owner has no path to decrease liquidity or transfer it.
contract PotatoV4FeeLocker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant CREATOR_FEE_SHARE_BPS = 5_000;
    uint256 private constant BPS = 10_000;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct LockedPosition {
        address creator;
        address token0;
        address token1;
    }

    address public immutable pad;
    IUniswapV4PositionManager public immutable positionManager;
    IWETH9V4 public immutable weth;
    address public immutable treasury;

    mapping(uint256 => LockedPosition) public positions;
    mapping(address => mapping(address => uint256)) public claimable;

    event PositionLocked(uint256 indexed tokenId, address indexed token, address indexed creator);
    event FeesCollected(uint256 indexed tokenId, address indexed caller, uint256 amount0, uint256 amount1);
    event FeesClaimed(address indexed asset, address indexed beneficiary, uint256 amount);
    event TreasuryPaid(address indexed asset, uint256 amount);
    event TreasuryPayFailed(address indexed asset, uint256 amount);
    event TokenFeesBurned(address indexed asset, uint256 amount);

    error OnlyPad();
    error UnknownPosition();
    error NothingToClaim();
    error EthTransferFailed();

    constructor(IUniswapV4PositionManager positionManager_, IWETH9V4 weth_, address treasury_) {
        pad = msg.sender;
        positionManager = positionManager_;
        weth = weth_;
        treasury = treasury_;
    }

    function register(
        uint256 tokenId,
        address launchedToken,
        address creator,
        address token0,
        address token1
    ) external {
        if (msg.sender != pad) revert OnlyPad();
        positions[tokenId] = LockedPosition({creator: creator, token0: token0, token1: token1});
        emit PositionLocked(tokenId, launchedToken, creator);
    }

    /// @notice Permissionless harvest. A zero-liquidity increase realizes the
    /// position's accrued v4 fees; TAKE_PAIR moves both assets to this locker.
    function collect(uint256 tokenId)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        LockedPosition memory pos = positions[tokenId];
        if (pos.creator == address(0)) revert UnknownPosition();

        uint256 before0 = IERC20(pos.token0).balanceOf(address(this));
        uint256 before1 = IERC20(pos.token1).balanceOf(address(this));

        bytes memory actions = abi.encodePacked(bytes1(uint8(0x00)), bytes1(uint8(0x11)));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            tokenId,
            uint256(0),
            type(uint128).max,
            type(uint128).max,
            bytes("")
        );
        params[1] = abi.encode(pos.token0, pos.token1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        amount0 = IERC20(pos.token0).balanceOf(address(this)) - before0;
        amount1 = IERC20(pos.token1).balanceOf(address(this)) - before1;
        _distribute(pos.token0, pos.creator, amount0);
        _distribute(pos.token1, pos.creator, amount1);
        emit FeesCollected(tokenId, msg.sender, amount0, amount1);
    }

    function claim(address asset) external nonReentrant returns (uint256 amount) {
        amount = claimable[asset][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[asset][msg.sender] = 0;
        if (asset == address(weth)) {
            weth.withdraw(amount);
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }
        emit FeesClaimed(asset, msg.sender, amount);
    }

    function _distribute(address asset, address creator, uint256 amount) internal {
        if (amount == 0) return;
        if (asset != address(weth)) {
            IERC20(asset).safeTransfer(DEAD, amount);
            emit TokenFeesBurned(asset, amount);
            return;
        }
        uint256 creatorCut = (amount * CREATOR_FEE_SHARE_BPS) / BPS;
        claimable[asset][creator] += creatorCut;
        _payTreasury(asset, amount - creatorCut);
    }

    function _payTreasury(address asset, uint256 amount) internal {
        if (amount == 0) return;
        weth.withdraw(amount);
        (bool ok,) = treasury.call{value: amount}("");
        if (ok) {
            emit TreasuryPaid(asset, amount);
        } else {
            weth.deposit{value: amount}();
            claimable[asset][treasury] += amount;
            emit TreasuryPayFailed(asset, amount);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}
