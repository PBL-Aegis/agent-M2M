import path from "node:path";
import { defineConfig } from "vitest/config";

// 테스트는 값이 고정된 픽스처만 본다. data/ 의 실제 스냅샷이 갱신돼도 테스트는 흔들리지 않는다.
// 결제는 테스트 전용 로컬 체인(8546)에 진짜로 보낸다. 같은 구매자 지갑을 쓰므로 테스트 파일은 하나씩 돌고,
// 테스트마다 체인을 처음 상태로 되돌린다(tests/setup/chain-snapshot.ts).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/local-chain.ts"],
    setupFiles: ["tests/setup/chain-snapshot.ts"],
    fileParallelism: false,
    env: {
      AGENT_M2M_DATA_DIR: path.join(import.meta.dirname, "tests", "fixtures"),
      AEGIS_LOCAL_RPC_URL: "http://127.0.0.1:8546",
      AEGIS_PAYMENT_MODE: "local",
    },
  },
  resolve: { alias: { "@": path.join(import.meta.dirname, "src") } },
});
