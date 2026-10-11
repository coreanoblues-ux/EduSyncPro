/**
 * 레벨테스트 앱(단일 HTML)을 배포 산출물로 복사한다.
 *
 * 실행: node scripts/copy-level-test-app.mjs  (npm run build 끝에 자동 실행)
 *
 * ── 왜 client/public 에 두지 않는가 ──
 *   client/public 은 vite 가 dist/public 으로 복사하고, server/vite.ts 의
 *   serveStatic 이 그 폴더를 express.static 으로 통째로 공개한다. 즉 거기 두면
 *   로그인 없이 누구나 내려받을 수 있다. 이 HTML 안에는 12개월치 레벨테스트
 *   문제와 **정답**이 들어 있다. 학생이 주소만 알면 정답지를 받는 셈이다.
 *
 *   그래서 정적 폴더가 아닌 dist/level-test 로 복사하고, 서버가
 *   authGuard 를 통과한 요청에만 res.sendFile 로 내려준다.
 *
 * ── 왜 dist 로 복사까지 하는가 (원본을 그냥 읽으면 안 되나) ──
 *   Railway(NIXPACKS) 배포는 소스 트리를 그대로 들고 있어서 apps/ 를 읽을 수
 *   있다. 그러나 docker/Dockerfile 의 런타임 스테이지는 dist/ 와
 *   node_modules/ 와 package.json 만 복사한다 — apps/ 가 없다. 그 경로로
 *   옮길 때 레벨테스트 화면만 조용히 404 가 되는 걸 막는다.
 */

import { copyFileSync, mkdirSync, existsSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const src = path.join(repoRoot, "apps", "level-test", "index.html");
const destDir = path.join(repoRoot, "dist", "level-test");
const dest = path.join(destDir, "index.html");

if (!existsSync(src)) {
  console.error(`❌ 레벨테스트 앱 원본이 없습니다: ${src}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

const kb = Math.round(statSync(dest).size / 1024);
console.log(`✔ 레벨테스트 앱 복사 완료 → dist/level-test/index.html (${kb} KB)`);
