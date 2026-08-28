import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

/**
 * Toss Front 2 플러그인 번들 설정.
 *
 * - base: "./"  → 산출물의 <script src="/assets/..."> 가 상대경로가 되어야
 *   Toss 개발자센터의 ZIP 업로드 후에도 어떤 하위 경로에 배포되든 자산이 로드된다.
 * - build.outDir: "dist" → 이 디렉토리 안의 파일들을 그대로 ZIP 루트에 넣는다.
 * - build.assetsDir: "assets" → dist/assets/index-xxxx.js 형태로 산출.
 * - build.rollupOptions.input: index.html (플러그인 HTML 진입점)
 * - build.target: "es2019" → Toss Front 단말기 웹뷰 호환 (Chromium 계열)
 * - build.sourcemap: false → ZIP 에 소스맵 포함 금지 (배포 자산 최소화 + 소스 노출 방지)
 * - build.emptyOutDir: true → 이전 빌드 잔재 제거
 * - build.minify: "esbuild" → 기본값. 별도 옵션 없음.
 */
export default defineConfig({
  base: "./",
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2019",
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});
