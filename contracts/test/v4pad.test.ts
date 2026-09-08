import { expect } from "chai";
import { ethers } from "hardhat";

const E = 10n ** 18n;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };

describe("PotatoV4Pad", () => {
  async function deploy() {
    const [deployer, treasury, creator] = await ethers.getSigners();
    const poolManager = await (await ethers.getContractFactory("MockV4PoolManager")).deploy();
    const positionManager = await (
      await ethers.getContractFactory("MockV4PositionManager")
    ).deploy();
    const weth = await (await ethers.getContractFactory("WETH9")).deploy();
    const pad = await (
      await ethers.getContractFactory("PotatoV4Pad")
    ).deploy(
      treasury.address,
      3n * E,
      10,
      poolManager.target,
      positionManager.target,
      weth.target,
      "0x0000000000000000000000000000000000000002",
      deployer.address,
      [],
    );
    return { deployer, treasury, creator, poolManager, positionManager, weth, pad };
  }

  it("maps the selectable standard fee percentages to v4 fee/tick-spacing pairs", async () => {
    const { pad } = await deploy();
    expect(await pad.tickSpacingForFee(100)).to.equal(1);
    expect(await pad.tickSpacingForFee(500)).to.equal(10);
    expect(await pad.tickSpacingForFee(3_000)).to.equal(60);
    expect(await pad.tickSpacingForFee(10_000)).to.equal(200);
    await expect(pad.tickSpacingForFee(2_500))
      .to.be.revertedWithCustomError(pad, "InvalidFee");
  });

  it("launches a token with the requested fee without changing the v3 pad", async () => {
    const ctx = await deploy();
    const salt = ethers.id("v4-spud");
    const token = await ctx.pad.connect(ctx.creator).createToken.staticCall(
      "V4 Spud",
      "V4SPUD",
      NO_META,
      salt,
      500,
    );
    const tx = await ctx.pad.connect(ctx.creator).createToken("V4 Spud", "V4SPUD", NO_META, salt, 500);
    await expect(tx).to.emit(ctx.pad, "V4PoolCreated");
    const info = await ctx.pad.v4Tokens(token);
    expect(info.creator).to.equal(ctx.creator.address);
    expect(info.fee).to.equal(500);
    expect(info.positionId).to.equal(1);
    expect(info.poolId).to.equal(await ctx.poolManager.lastPoolKey());

    // The real PositionManager requires every negative PoolManager delta to
    // be settled before unlock returns.  Keep this assertion alongside the
    // mock so a future action change cannot silently reintroduce the
    // non-settling `SETTLE(amount=0)` sequence.
    const [actions, params] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bytes", "bytes[]"],
      await ctx.positionManager.lastUnlockData(),
    );
    expect(actions).to.equal("0x020b0b14");
    expect(params).to.have.length(4);
  });

  it("does not silently accept an unsupported dev-buy", async () => {
    const ctx = await deploy();
    await expect(
      ctx.pad.connect(ctx.creator).createToken(
        "V4 No Buy",
        "V4NB",
        NO_META,
        ethers.id("v4-no-buy"),
        3_000,
        { value: 1n },
      ),
    ).to.be.revertedWithCustomError(ctx.pad, "DevBuyUnsupported");
  });
});
