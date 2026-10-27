/**
 * 로컬 체인. anvil 을 띄우고 AEGIS 토큰(contracts/)을 배포한 뒤 구매자 지갑에 발급한다.
 *
 *   npm run chain     # 켜 둔 채로 다른 창에서 npm run dev
 *
 * 주소는 AEGIS_LOCAL_RPC_URL(기본 http://127.0.0.1:8545)을 따른다. 자동 테스트는 8546 으로 따로 띄운다.
 *
 * 띄울 때마다 빈 체인에서 시작한다. 계정은 anvil 의 공개 테스트 계정이라 실제 자산이 없다.
 * 0번 계정이 운영자(배포·발급), 1번 계정이 구매자다. src/lib/payment.ts 의 local 모드가 같은 계정과
 * 같은 토큰 주소(운영자의 첫 거래로 배포한 주소)를 쓴다. Ctrl+C 로 끄면 체인도 사라진다.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createPublicClient, createWalletClient, getContractAddress, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const RPC_URL = (process.env.AEGIS_LOCAL_RPC_URL ?? "http://127.0.0.1:8545").trim();
const PORT = new URL(RPC_URL).port || "8545";
/** 구매자 지갑에 처음 넣는 양. 1000 AEGIS (소수점 6자리). */
const INITIAL_BUYER_UNITS = 1_000_000_000n;

const root = path.join(import.meta.dirname, "..");
const contracts = path.join(root, "contracts");
const owner = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
const buyer = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });

const build = spawnSync("forge", ["build"], { cwd: contracts, stdio: "inherit" });
if (build.status !== 0) {
  console.error("forge build 에 실패했습니다. Foundry 설치와 contracts/ 를 확인하세요.");
  process.exit(1);
}
const artifact = JSON.parse(readFileSync(path.join(contracts, "out", "AegisToken.sol", "AegisToken.json"), "utf8"));

const anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", PORT, "--mnemonic", ANVIL_MNEMONIC, "--silent"], {
  stdio: "inherit",
});
anvil.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => anvil.kill(signal));

const reader = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
const wallet = createWalletClient({ account: owner, chain: foundry, transport: http(RPC_URL) });

async function waitForChain() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await reader.getChainId();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`anvil 이 응답하지 않습니다. ${PORT} 포트를 다른 프로그램이 쓰고 있지 않은지 확인하세요.`);
}

try {
  await waitForChain();
  const expected = getContractAddress({ from: owner.address, nonce: 0n });
  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [owner.address],
  });
  const { contractAddress } = await reader.waitForTransactionReceipt({ hash: deployHash });
  if (contractAddress?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`토큰 주소가 예상과 다릅니다: ${contractAddress} (예상 ${expected})`);
  }
  const mintHash = await wallet.writeContract({
    address: contractAddress,
    abi: artifact.abi,
    functionName: "mint",
    args: [buyer.address, INITIAL_BUYER_UNITS],
  });
  await reader.waitForTransactionReceipt({ hash: mintHash });

  console.log(`로컬 체인 준비 완료 · ${RPC_URL} (chain ${foundry.id})`);
  console.log(`AEGIS 토큰 ${contractAddress}`);
  console.log(`구매자 ${buyer.address} · 1000 AEGIS 발급`);
  console.log("끄려면 Ctrl+C");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  anvil.kill("SIGTERM");
}
