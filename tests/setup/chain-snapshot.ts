/**
 * 테스트마다 로컬 체인을 처음 상태(배포 직후, 구매자 1000 AEGIS, 한도·요청 번호 기록 없음)로 되돌린다.
 * 체인 규칙(하루 한도, 60초 결제 횟수 등)은 결제 기록을 체인에 쌓으므로, 되돌리지 않으면
 * 앞 테스트의 결제가 뒤 테스트를 막는다. 모든 테스트 파일에 자동으로 적용된다(vitest.config.ts 의 setupFiles).
 */

import { afterEach, beforeEach } from "vitest";

import { chainRpc } from "../helpers/chain";

let snapshotId: string | null = null;

beforeEach(async () => {
  snapshotId = await chainRpc<string>("evm_snapshot");
});

afterEach(async () => {
  if (snapshotId === null) return;
  const reverted = await chainRpc<boolean>("evm_revert", [snapshotId]);
  snapshotId = null;
  if (!reverted) throw new Error("테스트용 로컬 체인을 처음 상태로 되돌리지 못했습니다");
});
