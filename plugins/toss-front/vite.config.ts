import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

/**
 * 버전은 package.json 하나만 본다.
 *
 * 0.3.3 까지는 버전 문자열이 package.json · manifest.json · src/index.ts 세 곳에
 * 손으로 복사돼 있었다. 단말기 화면에 찍히는 "version=..." 은 지금 어떤 ZIP 이 돌고
 * 있는지 확인하는 유일한 수단인데, 그게 나머지 둘과 어긋나면 배포를 확인할 방법이
 * 사라진다. 실제로 0.2.0 검은 화면 때 옛 ZIP 을 올린 걸 아무도 몰랐던 이유가 이거였다.
 * manifest.json 과의 일치는 scripts/pack-toss-plugin.mjs 가 따로 막는다.
 */
const pkgVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")
).version as string;

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
 * - build.modulePreload.polyfill: false (0.3.27) → Vite 기본 폴리필은
 *   createElement("link") 로 <link rel="modulepreload"> 를 주입해 **여러 청크**를
 *   미리 내려받게 하는 코드다. 이 플러그인은 동적 import 가 없어 청크가 단 하나
 *   (assets/index-*.js)뿐이므로 폴리필이 실제로 할 일이 없다. 그런데 그 안의
 *   createElement 호출이 번들 DOM 검사에서 계속 걸려 검수 설명 부담만 만들었다.
 *   빌드 설정으로 정식 제거한다 (번들 문자열 사후 치환 아님). 청크가 하나뿐이라
 *   실행 호환성에는 영향이 없다.
 */
export default defineConfig({
  base: "./",
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkgVersion),
  },
  build: {
    modulePreload: { polyfill: false },
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
