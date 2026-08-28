/**
 * Toss 개발자센터 업로드용 플러그인 ZIP 생성.
 *
 * 왜 스크립트로 만드나:
 *   0.2.0 배포본은 소스 디렉토리를 그대로 압축한 것이었다. 그 안에는 실행 불가능한
 *   src/*.ts 가 들어 있었고 manifest 의 entry 도 그 .ts 를 가리키고 있었다.
 *   단말기 웹뷰는 TypeScript 를 실행하지 못하므로 스크립트가 아예 로드되지 않았고,
 *   그래서 플러그인 로그가 단 한 줄도 남지 않은 채 검은 화면만 보였다.
 *   손으로 압축하는 한 이 실수는 반복된다. 그래서 절차를 코드로 고정한다.
 *
 * ZIP 에 들어가는 것 (이게 전부다):
 *   manifest.json          — entry: "index.html"
 *   index.html             — Vite 가 번들 스크립트 경로로 다시 쓴 산출물
 *   assets/index-*.js      — 실제 실행되는 번들
 *
 * 들어가지 않는 것: src/, node_modules/, package.json, tsconfig, vite.config,
 * 예제 파일, 소스맵. Toss 심사에서 불필요한 파일은 지적 대상이다.
 *
 * 사용: npm run plugin:pack
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "..", "plugins", "toss-front");
const distDir = path.join(pluginDir, "dist");
const stageDir = path.join(pluginDir, ".pack");
const manifestPath = path.join(pluginDir, "manifest.json");

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

// ─── 1. 빌드 산출물 확인 ────────────────────────────────────────────────
if (!fs.existsSync(distDir)) {
  fail("dist/ 가 없습니다. 먼저 `npm run plugin:build` 를 실행하세요.");
}
const distIndex = path.join(distDir, "index.html");
if (!fs.existsSync(distIndex)) fail("dist/index.html 이 없습니다. 빌드가 실패했을 수 있습니다.");

const indexHtml = fs.readFileSync(distIndex, "utf8");
// 가장 중요한 검사: 빌드 결과가 .ts 를 참조하면 단말기에서 절대 실행되지 않는다.
if (/src\/.*\.ts/.test(indexHtml)) {
  fail("dist/index.html 이 아직 .ts 를 참조합니다. Vite 빌드 산출물이 아닙니다.");
}
if (!/<script[^>]+src=["']\.\/assets\//.test(indexHtml)) {
  fail("dist/index.html 에 번들 스크립트(<script src=\"./assets/...\">) 참조가 없습니다.");
}

// ─── 2. manifest 검증 ───────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.entry !== "index.html") {
  fail(`manifest.entry 가 "${manifest.entry}" 입니다. "index.html" 이어야 합니다.`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  fail(`버전 불일치: manifest=${manifest.version} package=${pkg.version}. 두 값을 맞추세요.`);
}

// ─── 3. 스테이징 ────────────────────────────────────────────────────────
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
// fs.cpSync 는 Windows + 경로에 CJK 문자가 있으면 조용히 exit 127 로 죽는 관찰 사례가
// 있어 (node v20~24 재현), 스테이징은 재귀 복사를 수동으로 돌린다.
function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}
copyRecursive(distDir, stageDir);
fs.copyFileSync(manifestPath, path.join(stageDir, "manifest.json"));

// 소스맵이 섞여 들어갔으면 제거
for (const f of fs.readdirSync(path.join(stageDir, "assets"))) {
  if (f.endsWith(".map")) fs.rmSync(path.join(stageDir, "assets", f));
}

// ─── 4. 압축 ────────────────────────────────────────────────────────────
/**
 * ZIP 을 직접 쓴다. 외부 도구를 쓰지 않는 이유:
 *   Windows 의 Compress-Archive 는 엔트리 경로를 역슬래시("assets\index.js")로 기록한다.
 *   ZIP 규격(APPNOTE 4.4.17)은 슬래시를 요구하고, 엄격한 해제기는 이걸 디렉토리가 아니라
 *   "assets\index.js" 라는 이름의 단일 파일로 푼다. 그러면 index.html 이 참조하는
 *   ./assets/index.js 가 없어서 스크립트가 로드되지 않는다 — 우리가 지금 고치고 있는
 *   바로 그 증상(검은 화면 + 로그 없음)이 배포 단계에서 재현된다.
 *   플랫폼에 따라 결과물이 달라지는 것도 곤란하다. 집·학원 두 대에서 같은 ZIP 이 나와야 한다.
 */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const dosTime = (d) =>
    ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
  const dosDate = (d) =>
    (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8"); // 항상 슬래시 구분자
    const deflated = zlib.deflateRawSync(f.data, { level: 9 });
    const useDeflate = deflated.length < f.data.length;
    const body = useDeflate ? deflated : f.data;
    const crc = zlib.crc32 ? zlib.crc32(f.data) : crc32(f.data);
    const now = new Date();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 파일명 플래그
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime(now), 10);
    local.writeUInt16LE(dosDate(now), 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(dosTime(now), 12);
    cd.writeUInt16LE(dosDate(now), 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/** zlib.crc32 는 Node 20.15+ 에만 있다. 없으면 직접 계산한다. */
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 스테이지 디렉토리를 훑어 ZIP 엔트리 목록으로 만든다 (경로는 항상 슬래시). */
function collect(dir, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...collect(full, rel));
    else out.push({ name: rel, data: fs.readFileSync(full) });
  }
  return out;
}

/**
 * 산출물은 releases/ 에 떨군다.
 *
 * 이 폴더만 .gitignore 예외라서, 여기 놓이는 순간 저장소에 함께 남는다.
 * 플러그인 폴더 여기저기에 ZIP 이 굴러다니면 개발자센터에 옛 버전을 올리게 되는데,
 * 0.2.0 검은 화면 사고가 정확히 그런 식으로 났다. 올릴 파일이 있는 곳은 한 군데뿐이어야 한다.
 */
const releaseDir = path.join(pluginDir, "releases");
fs.mkdirSync(releaseDir, { recursive: true });

const zipName = `edusyncpro-front-${manifest.version}.zip`;
const zipPath = path.join(releaseDir, zipName);
fs.rmSync(zipPath, { force: true });

const entries = collect(stageDir);
fs.writeFileSync(zipPath, buildZip(entries));

fs.rmSync(stageDir, { recursive: true, force: true });

// ─── 5. 결과 보고 ───────────────────────────────────────────────────────
const size = fs.statSync(zipPath).size;
console.log("\n✅ Toss 업로드용 ZIP 생성 완료");
console.log(`   파일: ${zipPath}`);
console.log(`   크기: ${(size / 1024).toFixed(1)} KB`);
console.log(`   버전: ${manifest.version}  (id=${manifest.id}, entry=${manifest.entry})`);
console.log(`   포함(${entries.length}개): ${entries.map((e) => e.name).join(", ")}`);
console.log("\n   업로드: 토스 개발자센터 → Front 플러그인 → 새 버전 업로드 → 이 ZIP 선택\n");
