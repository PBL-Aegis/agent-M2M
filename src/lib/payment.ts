/**
 * 결제. AEGIS 토큰(ERC-20)의 pay 로 선택된 모델의 수신자 주소에 보낸다.
 * pay 는 요청 번호를 함께 받아 체인의 감사 규칙(contracts/)을 돌린 뒤 송금한다.
 * 그래서 live 는 pay 가 있는 토큰(contracts/src/AegisToken.sol)을 배포한 주소에서만 동작한다.
 *
 * 기본값은 local 이다. 이 컴퓨터의 anvil(npm run chain)에 올린 토큰으로 보낸다. 실제 자산은 오가지 않는다.
 * 자동 테스트(npm test)도 테스트 전용 anvil(AEGIS_LOCAL_RPC_URL)을 띄워 같은 local 경로로 진짜 결제한다.
 * Base Sepolia 전송은 두 가지가 모두 켜져 있을 때만 일어난다.
 *   AEGIS_PAYMENT_MODE=live
 *   AEGIS_REAL_PAYMENT_APPROVED=yes
 * 개인키는 이 파일 안에서만 읽고, 밖으로 내보내지 않는다. 화면과 기록에는 주소만 남는다.
 */

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  stringToBytes,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";

import type { PaymentMode, PaymentResult } from "./types";

export const AEGIS_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "requestId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paid",
    inputs: [
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** anvil 이 띄울 때마다 똑같이 만드는 공개 테스트 계정. 로컬 체인에서만 쓰고, 실제 자산은 없다. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const DEFAULT_LOCAL_RPC_URL = "http://127.0.0.1:8545";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** 로컬 체인 주소. 자동 테스트는 개발용 체인과 부딪치지 않게 다른 포트를 쓴다. 이 컴퓨터 주소만 받는다. */
export function localRpcUrl(): string {
  const value = (process.env.AEGIS_LOCAL_RPC_URL ?? DEFAULT_LOCAL_RPC_URL).trim();
  const url = new URL(value);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new PaymentError(`AEGIS_LOCAL_RPC_URL 은 이 컴퓨터 주소(127.0.0.1)여야 합니다: ${value}`);
  }
  return value;
}

/** 0번 계정은 운영자(토큰 배포·발급), 1번 계정은 구매자다. scripts/local-chain.mjs 도 같은 계정을 쓴다. */
export function localAccounts() {
  return {
    owner: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 }),
    buyer: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 }),
  };
}

/** 새로 띄운 anvil 에서 운영자의 첫 거래로 배포한 토큰 주소. npm run chain 이 이 순서로 배포한다. */
export function localTokenAddress(): string {
  return getContractAddress({ from: localAccounts().owner.address, nonce: 0n });
}

/** 체인에 넘기는 요청 번호. 요청 번호 문자열의 keccak256 이다. */
export function requestIdHash(requestId: string): Hex {
  return keccak256(stringToBytes(requestId));
}

/** sent 가 true 면 거래를 체인에 보낸 뒤 실패한 것이다. 돈이 나갔을 수 있다. */
export class PaymentError extends Error {
  constructor(
    message: string,
    readonly sent = false,
  ) {
    super(message);
  }
}

export interface PaymentConfig {
  mode: PaymentMode;
  tokenAddress: string;
  chainId: number;
  rpcUrl: string;
  buyerAddress: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new PaymentError(`${name} 환경변수가 필요합니다`);
  }
  return value.trim();
}

/** 화면에 보여줄 수 있는 설정만 모은다. 개인키는 여기에 들어가지 않는다. */
export function paymentConfig(): PaymentConfig {
  const approved = process.env.AEGIS_REAL_PAYMENT_APPROVED === "yes";
  const requested = (process.env.AEGIS_PAYMENT_MODE ?? "local").trim().toLowerCase();
  const mode: PaymentMode = requested === "live" && approved ? "live" : "local";
  if (mode === "local") {
    return {
      mode,
      tokenAddress: localTokenAddress(),
      chainId: foundry.id,
      rpcUrl: localRpcUrl(),
      buyerAddress: localAccounts().buyer.address,
    };
  }
  const key = process.env.AEGIS_BUYER_PRIVATE_KEY;
  return {
    mode,
    tokenAddress: process.env.AEGIS_TOKEN_ADDRESS ?? "",
    chainId: Number(process.env.AEGIS_CHAIN_ID ?? baseSepolia.id),
    rpcUrl: process.env.AEGIS_RPC_URL ?? "https://sepolia.base.org",
    buyerAddress:
      key === undefined || key.trim() === ""
        ? null
        : privateKeyToAccount(key.trim() as Hex).address,
  };
}

function chainOf(config: PaymentConfig) {
  return config.mode === "live" ? baseSepolia : foundry;
}

/** 로컬 체인은 거래를 바로 블록에 넣으므로 결과를 짧은 간격으로 확인한다. live 는 viem 기본값(4초)을 쓴다. */
const LOCAL_POLLING_MS = 100;

export function publicClient(config: PaymentConfig) {
  return createPublicClient({
    chain: chainOf(config),
    transport: http(config.rpcUrl),
    ...(config.mode === "local" ? { pollingInterval: LOCAL_POLLING_MS } : {}),
  });
}

/** 대시보드에 보여줄 구매 에이전트 지갑의 AEGIS 잔액. 조회하지 못하면 units는 null이고 사유를 남긴다. */
export async function buyerBalance(): Promise<{ units: number | null; status: string }> {
  const config = paymentConfig();
  if (config.buyerAddress === null) return { units: null, status: "잔액 조회 안 함 · 지갑 미구성" };
  if (config.tokenAddress.trim() === "") return { units: null, status: "잔액 조회 안 함 · 토큰 주소 미구성" };
  try {
    const balance = await publicClient(config).readContract({
      address: getAddress(config.tokenAddress.trim()),
      abi: AEGIS_ABI,
      functionName: "balanceOf",
      args: [getAddress(config.buyerAddress)],
    });
    const where = config.mode === "live" ? "Base Sepolia" : "로컬 체인";
    return { units: Number(balance), status: `${where} 온체인 잔액 조회 완료` };
  } catch {
    return { units: null, status: "잔액 조회 실패 · RPC 응답 없음" };
  }
}

/**
 * 같은 지갑으로 거의 동시에 보내면 거래 순번(nonce)이 겹쳐 뒤의 거래가 거절된다.
 * 이 프로세스 안에서는 보내기를 한 줄로 세워, 앞 거래가 체인에 들어간 뒤 다음 거래가 순번을 받게 한다.
 */
let sending: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(send: () => Promise<T>): Promise<T> {
  const run = sending.then(send, send);
  sending = run.catch(() => undefined);
  return run;
}

export async function pay(args: {
  amountUnits: number;
  recipient: string;
  purchaseId: string;
  requestId: string;
}): Promise<PaymentResult> {
  const config = paymentConfig();
  const to = getAddress(args.recipient);
  const requestHash = requestIdHash(args.requestId);

  const live = config.mode === "live";
  const token = getAddress(live ? requiredEnv("AEGIS_TOKEN_ADDRESS") : config.tokenAddress);
  const account = live
    ? privateKeyToAccount(requiredEnv("AEGIS_BUYER_PRIVATE_KEY") as Hex)
    : localAccounts().buyer;
  const wallet = createWalletClient({
    account,
    chain: chainOf(config),
    transport: http(config.rpcUrl),
  });
  const reader = publicClient(config);

  const balance = await reader.readContract({
    address: token,
    abi: AEGIS_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (balance < BigInt(args.amountUnits)) {
    throw new PaymentError(
      `지갑 잔액이 부족합니다: 보유 ${balance.toString()} / 필요 ${args.amountUnits}`,
    );
  }

  const txHash = await oneAtATime(() =>
    wallet.writeContract({
      address: token,
      abi: AEGIS_ABI,
      functionName: "pay",
      args: [to, BigInt(args.amountUnits), requestHash],
    }),
  );
  // 여기부터는 거래가 체인에 나간 뒤다. 어떤 실패든 송금 후 실패로 알린다.
  let receipt;
  try {
    receipt = await reader.waitForTransactionReceipt({ hash: txHash });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new PaymentError(`전송 결과를 확인하지 못했습니다: ${txHash} (${reason})`, true);
  }
  if (receipt.status !== "success") {
    throw new PaymentError(`전송이 실패했습니다: ${txHash}`, true);
  }

  return {
    mode: config.mode,
    txHash,
    from: account.address,
    to,
    amountUnits: args.amountUnits,
    tokenAddress: token,
    chainId: config.chainId,
    requestIdHash: requestHash,
    blockNumber: receipt.blockNumber.toString(),
  };
}
