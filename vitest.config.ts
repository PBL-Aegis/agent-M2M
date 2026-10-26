import path from "node:path";
import { defineConfig } from "vitest/config";

// 테스트는 값이 고정된 픽스처만 본다. data/ 의 실제 스냅샷이 갱신돼도 테스트는 흔들리지 않는다.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: { AGENT_M2M_DATA_DIR: path.join(import.meta.dirname, "tests", "fixtures") },
  },
  resolve: { alias: { "@": path.join(import.meta.dirname, "src") } },
});
