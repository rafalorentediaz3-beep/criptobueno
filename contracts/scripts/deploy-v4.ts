import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the optional v4 launch path. The addresses below are the official
 * Robinhood Chain v4 deployments; no v4 npm package is needed by the pad.
 *
 * Run:
 *   TREASURY=0x... OWNER=0x... npx hardhat run scripts/deploy-v4.ts --network robinhoodMainnet
 */
const ROBINHOOD_V4 = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  universalRouter: "0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
};

const DEFAULT_TREASURY = "0xd3358b1F39A6a71911c6e33717D185F99d43e80d";
const BANNED = [
  "CASHCAT", "Cash Cat", "TENDIES", "JUGGERNAUT", "The Juggernaut", "FOX",
  "Robin Hood", "WISHBONE", "STONKS", "DFV", "DeepFuckingValue", "meow", "GME", "GameStop",
];

async function main() {
  if (network.name !== "robinhoodMainnet") {
    throw new Error("deploy-v4.ts is intentionally restricted to Robinhood mainnet");
  }
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY || DEFAULT_TREASURY;
  const owner = process.env.OWNER || treasury;
  const startFdv = ethers.parseEther(process.env.START_FDV_ETH || "3");
  const antiSnipeBlocks = BigInt(process.env.ANTI_SNIPE_BLOCKS || "1200");

  const pad = await (
    await ethers.getContractFactory("PotatoV4Pad")
  ).deploy(
    treasury,
    startFdv,
    antiSnipeBlocks,
    ROBINHOOD_V4.poolManager,
    ROBINHOOD_V4.positionManager,
    ROBINHOOD_V4.weth,
    ROBINHOOD_V4.permit2,
    owner,
    BANNED,
  );
  await pad.waitForDeployment();
  const receipt = await pad.deploymentTransaction()?.wait();
  const deployment = {
    network: network.name,
    deployer: deployer.address,
    v4Pad: pad.target,
    locker: await pad.locker(),
    tokenFactory: await pad.tokenFactory(),
    deployBlock: receipt?.blockNumber ?? 0,
    treasury,
    owner,
    startFdv: startFdv.toString(),
    antiSnipeBlocks: antiSnipeBlocks.toString(),
    ...ROBINHOOD_V4,
  };
  const file = path.join(__dirname, `../deployments.v4.${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));
  console.log(JSON.stringify(deployment, null, 2));
  console.log(`\nSet NEXT_PUBLIC_V4_PAD_ADDRESS_ROBINHOOD=${pad.target}`);
  console.log(`Set v4PadStartBlock to ${deployment.deployBlock} in web/lib/config.ts`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
