/**
 * 테스트에서 로컬 체인(anvil)을 직접 다루는 도구. 주소는 vitest.config.ts 의 AEGIS_LOCAL_RPC_URL 이다.
 */

export async function chainRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const url = process.env.AEGIS_LOCAL_RPC_URL;
  if (url === undefined) throw new Error("AEGIS_LOCAL_RPC_URL 이 없습니다");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method} 실패: ${body.error.message}`);
  return body.result as T;
}

/** 체인 시계를 앞으로 돌린다. "60초 지나면 다시 결제", "하루 지나면 한도 초기화" 같은 테스트에 쓴다. */
export async function increaseChainTime(seconds: number): Promise<void> {
  await chainRpc("evm_increaseTime", [seconds]);
  await chainRpc("evm_mine");
}
