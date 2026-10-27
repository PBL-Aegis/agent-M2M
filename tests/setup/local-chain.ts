/**
 * 자동 테스트 전용 로컬 체인. npm test 가 시작할 때 scripts/local-chain.mjs 로 anvil 을 띄우고
 * 토큰 배포·구매자 발급까지 마친 뒤 테스트를 돌리고, 끝나면 끈다.
 * 개발용 체인(8545)과 부딪치지 않게 vitest.config.ts 의 AEGIS_LOCAL_RPC_URL(8546)을 쓴다.
 */

import { spawn } from "node:child_process";
import path from "node:path";

import type { TestProject } from "vitest/node";

const READY = "로컬 체인 준비 완료";
const TIMEOUT_MS = 120_000;

export default async function setup(project: TestProject): Promise<() => void> {
  const root = path.join(import.meta.dirname, "..", "..");
  const child = spawn(process.execPath, [path.join(root, "scripts", "local-chain.mjs")], {
    cwd: root,
    env: { ...process.env, AEGIS_LOCAL_RPC_URL: project.config.env.AEGIS_LOCAL_RPC_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`테스트용 로컬 체인이 ${TIMEOUT_MS / 1000}초 안에 준비되지 않았습니다.\n${output}`)), TIMEOUT_MS);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(READY)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`테스트용 로컬 체인이 꺼졌습니다(종료 코드 ${code}). Foundry(forge, anvil)가 설치돼 있는지 확인하세요.\n${output}`));
    });
  });

  return () => {
    child.kill("SIGTERM");
  };
}
