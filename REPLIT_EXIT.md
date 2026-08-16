# Replit 없이 돌리기

작성 계기: **Replit 구독 크레딧이 만료되자 앱 로그인이 안 됐고, 재구독하니 정상으로 돌아왔다.**
앱은 Railway에서 도는데 왜 Replit 결제가 로그인을 끊었는지, 그리고 구독을 완전히
해지해도 되는 상태로 만들려면 무엇을 해야 하는지를 정리한 문서다.

---

## 1. 전수 스캔 결과 — Replit에 매여 있던 지점

저장소 전체(`client`, `server`, `shared`, 설정 파일, 배포 스크립트)를 훑은 결과다.

| # | 위치 | 무엇 | 위험도 | 조치 |
|---|------|------|--------|------|
| 1 | 운영 DB (`DATABASE_URL`) | Replit이 만들어준 Neon 프로젝트를 가리킬 가능성이 높음 | 🔴 치명 | **사용자 확인 필요 — 3장** |
| 2 | `client/index.html` | `https://replit.com/.../replit-dev-banner.js` 를 매 페이지 로드마다 불러옴 | 🟠 높음 | ✅ 삭제함 |
| 3 | `.replit` | Replit 전용 실행/배포 설정. `postgresql-16` 모듈과 `javascript_database` 통합 선언 | 🟡 중간 | ✅ 삭제 + 추적 해제 |
| 4 | `.local/` (188개 파일, 27MB) | Replit 에이전트 내부 상태가 통째로 커밋돼 있었음 | 🟡 중간 | ✅ 추적 해제 (디스크에는 남김) |
| 5 | `server/middleware/auth.ts` | `JWT_SECRET` 기본값이 공개 저장소에 박힌 고정 문자열 | 🟠 높음 | ✅ 부팅 시 무작위 생성으로 교체 |
| 6 | `replit.md` | 이름만 Replit, 내용은 멀쩡한 아키텍처 문서 | 🟢 낮음 | ✅ `ARCHITECTURE.md`로 개명 |
| 7 | `DEPLOY_RAILWAY.md` STEP 1 | "Replit → Tools → Secrets에서 DATABASE_URL 복사"라고 안내 | 🟢 낮음 | ✅ Neon 콘솔 기준으로 수정 |
| 8 | `railway.env.example` | 이름이 Railway 전용처럼 보여 로컬/도커에서 안 쓰임 | 🟢 낮음 | ✅ `.env.example`로 개명 |

### 확인 결과 — 문제가 **없던** 곳

이건 좋은 소식이다. 애플리케이션 코드 자체는 이미 Replit과 무관하다.

- **`@replit/*` 패키지 0개.** `package.json`, `vite.config.ts` 모두 깨끗하다.
  (예전에 `@replit/vite-plugin-*` 2개를 이미 제거해 뒀다.)
- **Replit Auth 안 씀.** 로그인은 `server/middleware/auth.ts`의 자체 구현이다 —
  `bcryptjs`로 비밀번호 해시, `jsonwebtoken`으로 7일짜리 토큰. 전부 우리 서버 안에서 끝난다.
- **Replit DB / Object Storage 안 씀.** `server/db.ts`는 평범한 `pg.Pool`에
  `DATABASE_URL`을 넣을 뿐이다.
- **Replit이 자동 주입하는 환경변수(`REPL_ID`, `REPLIT_DB_URL`, `REPL_OWNER` 등)를
  읽는 코드 0곳.** 필요한 변수는 `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`,
  `PORT`, 선택적으로 `OPENAI_API_KEY` — 이게 전부다.
- **포트/호스트 설정 정상.** `process.env.PORT || 3000`, `host: "0.0.0.0"` 이라
  Railway든 도커든 그대로 뜬다.

---

## 2. 왜 로그인이 끊겼나 (원인 추정과 근거)

앱 서버는 Railway에 있었으니 Replit 결제와 무관해야 정상이다. 그런데도 끊긴 이유는
**DB가 Replit 소유일 가능성이 높기 때문**이다. 근거는 두 가지다.

1. `DEPLOY_RAILWAY.md`의 STEP 1이 "**Replit 프로젝트 → Tools → Secrets →
   DATABASE_URL 값 복사**"였다. 즉 Railway에 넣은 DB 주소의 출처가 Replit이다.
2. 삭제된 `.replit`에 `modules = [..., "postgresql-16"]` 과
   `[agent] integrations = ["javascript_database:1.0.0"]` 가 있었다. Replit이
   프로젝트에 Neon DB를 붙여줬다는 뜻이다.

Replit이 붙여준 Neon 프로젝트는 **Replit 계정 소유**다. 구독이 끊기면 그 DB가 잠긴다.
그러면 Railway의 서버는 멀쩡히 살아 있어도 로그인 시 사용자 조회 쿼리가 실패하고,
화면에는 "로그인이 안 된다"로 보인다. 증상이 정확히 일치한다.

> **이건 확인이 필요한 추정이다.** 3장의 A단계에서 30초 안에 확실히 판별할 수 있다.

---

## 3. DB 독립시키기 — 데이터는 절대 잃지 않는 순서로

⚠️ **원칙: 백업 → 검증 → 이관 → 대조 → 그 다음에야 전환.**
학생·결제 기록이 걸린 작업이므로 순서를 건너뛰지 말 것.

### A단계 — 지금 DB가 누구 것인지 판별 (먼저 이것부터)

1. https://console.neon.tech 에 **본인 이메일 계정으로** 로그인한다.
2. Railway → EduSyncPro 서비스 → Variables → `DATABASE_URL` 값을 연다.
   `@ep-xxxx-yyyy.한지역.aws.neon.tech` 부분의 **`ep-` 호스트 이름**을 확인한다.
3. Neon 콘솔의 내 프로젝트 목록에 그 호스트가 있는가?

| 결과 | 의미 | 할 일 |
|------|------|-------|
| **있다** | DB는 이미 내 것. Replit과 무관 | B단계 백업만 받아두고 **C단계(이관)는 건너뛴다** |
| **없다** | DB는 Replit 소유 → 해지하면 데이터가 잠긴다 | B → C → D 전부 진행. **이관 전에는 절대 해지 금지** |

### B단계 — 백업 (어느 경우든 무조건)

로컬 PC에 PostgreSQL 클라이언트 도구가 필요하다 (`psql`, `pg_dump`).
없으면 https://www.postgresql.org/download/windows/ 에서 설치하고 설치 중
"Command Line Tools"를 체크한다.

```bash
# 1) 옮기기 전 상태를 숫자로 남긴다. 이 출력을 파일로 저장해 둘 것.
DATABASE_URL="<현재_운영_DATABASE_URL>" npm run db:verify | tee backup-before.txt

# 2) 실제 덤프. -Fc는 압축 포맷이라 복원할 때 순서를 알아서 맞춘다.
pg_dump -Fc --no-owner --no-acl \
  -d "<현재_운영_DATABASE_URL>" \
  -f edusync-backup-$(date +%Y%m%d).dump

# 3) 파일이 진짜 들어찼는지 확인 (몇 KB짜리면 실패한 것이다)
ls -lh edusync-backup-*.dump
```

> 💡 이 `.dump` 파일을 클라우드 드라이브 등 PC 밖에도 한 벌 복사해 둘 것.
> 그리고 `.gitignore`에 이미 `*.tar.gz`가 있지만 `.dump`는 없으니,
> **저장소 폴더 밖에 두거나 커밋하지 말 것** — 학생 개인정보가 통째로 들어 있다.

### C단계 — 새 DB로 이관 (A단계가 "없다"일 때만)

**선택지 1 — Neon 유지 (권장).** 지금과 동작이 같아 바뀌는 게 주소뿐이다.

```
console.neon.tech → 본인 계정 → New Project
→ 이름: edusync-prod / 리전: 기존과 같은 곳(가급적)
→ 생성 후 Connection string 복사 (?sslmode=require 포함된 것)
```

**선택지 2 — Railway Postgres.** 앱과 같은 곳에 두어 관리 지점을 하나로 줄인다.
Railway 프로젝트 → New → Database → PostgreSQL → 생성되면 Variables의
`DATABASE_URL`을 쓴다. (Neon의 자동 절전이 없어 첫 요청이 느려지는 일도 없다.)

복원:

```bash
# 1) 빈 DB에 스키마를 만든다
DATABASE_URL="<새_DATABASE_URL>" npm run db:push

# 2) 데이터 복원. 스키마가 이미 있으므로 --data-only.
pg_restore --no-owner --no-acl --data-only --disable-triggers \
  -d "<새_DATABASE_URL>" \
  edusync-backup-YYYYMMDD.dump

# 3) 옮기기 전 숫자와 한 줄씩 대조한다. 이 단계를 건너뛰지 말 것.
DATABASE_URL="<새_DATABASE_URL>" npm run db:verify | tee backup-after.txt
diff backup-before.txt backup-after.txt
```

`diff`가 시각 표시 줄 말고는 아무것도 뱉지 않아야 정상이다.
건수·결제 합계·마지막 결제일·학생 수가 전부 같아야 한다.

### D단계 — 전환

```
Railway → EduSyncPro → Variables → DATABASE_URL 을 새 주소로 교체 → Save
→ 자동 재배포 (2~3분)
→ Deployments → Logs 에서 "✅ Database connection verified" 확인
```

> 🛟 되돌리기: 옛 `DATABASE_URL` 값을 메모장에 남겨 두면 문제 시 변수만 되돌리면 된다.
> 옛 DB는 **최소 2주는 지우지 말 것.**

---

## 4. Replit 계정 없이 전 기능이 되는지 확인하는 방법

### 4-1. 내 PC에서 (Replit 접속 없이, 인터넷 없이도 대부분 확인 가능)

```bash
cd EduSyncPro
cp .env.example .env      # 값 채우기: DATABASE_URL / JWT_SECRET / ADMIN_PASSWORD
npm install
npm run dev               # → http://localhost:3000
```

브라우저에서 **개발자도구 → Network 탭을 열어 둔 채** 아래를 확인한다.

- [ ] `replit.com` 으로 나가는 요청이 **한 건도 없다** (배너 스크립트를 지웠으므로)
- [ ] 로그인 화면이 뜬다
- [ ] 원장 계정으로 로그인 → 대시보드 진입
- [ ] 관리자 로그인(`/api/auth/admin-login`, `ADMIN_PASSWORD` 사용)도 동작
- [ ] 학생 목록·반 목록이 보인다 (DB 읽기)
- [ ] 학생 1명 등록 → 목록에 뜬다 (DB 쓰기)
- [ ] 수납 처리 1건 → 미납 목록에서 빠진다
- [ ] 퇴근전 할 일 추가/완료
- [ ] AI 빠른 입력 (`OPENAI_API_KEY`를 넣었을 때만. 없으면 이 기능만 비활성)
- [ ] 로그아웃 → 재로그인

### 4-2. 도커로 (Node조차 안 깔린 새 PC에서도 도는지)

```bash
docker build -t edusync .
docker run -p 3000:3000 --env-file .env edusync
```

컨테이너 안에는 Replit 관련 파일이 하나도 안 들어간다(`.dockerignore`).
여기서 뜨면 "Replit 없이 어디서든 실행 가능"이 증명된 것이다.

### 4-3. 결정적 검증 — Replit 로그아웃 상태로 운영 사이트 쓰기

1. 브라우저 시크릿 창을 연다 (Replit 세션이 전혀 없는 상태).
2. Railway 운영 주소로 접속해 4-1의 체크리스트를 그대로 반복한다.
3. 전부 되면 **운영 서비스는 Replit과 무관하게 살아 있다**.

### 4-4. 코드 검증

```bash
npx tsc --noEmit          # 타입 오류 0
npm run build             # 빌드 성공
npm run test:nlp          # 자연어 파서 167케이스 통과
```

---

## 5. Replit 구독 해지 전 최종 체크리스트

**아래 항목이 전부 ✅ 가 되기 전에는 해지하지 말 것.**

### 데이터 (가장 중요)

- [ ] `pg_dump` 백업 파일을 만들었고, PC 밖에도 한 벌 더 있다
- [ ] 3장 A단계로 `DATABASE_URL`이 **내 Neon/Railway 계정 소유**임을 눈으로 확인했다
- [ ] (이관했다면) `db:verify` 출력이 이관 전/후로 동일하다
- [ ] Replit 프로젝트 안에만 있고 GitHub에는 없는 파일이 없다
      (Replit 파일 트리를 훑어보고, 필요하면 프로젝트 전체를 zip으로 내려받아 둔다)

### 실행

- [ ] GitHub 저장소에 최신 코드가 푸시돼 있다
- [ ] Railway가 GitHub에서 자동 배포하도록 연결돼 있다 (Replit 경유 아님)
- [ ] Railway Variables에 `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`가 들어 있다
      (`JWT_SECRET`이 비어 있으면 재배포마다 전원 로그아웃된다)
- [ ] 최근 배포 로그에 `✅ Database connection verified` 가 찍혀 있다
- [ ] 4-3의 시크릿 창 테스트를 통과했다

### 도메인 / 접속 경로

- [ ] 평소 쓰는 주소가 `*.replit.app` / `*.repl.co` 가 **아니다**
      (맞다면 Railway 도메인이나 직접 산 도메인으로 먼저 갈아타고 원장·강사에게 공지)
- [ ] 휴대폰 홈 화면 바로가기, 즐겨찾기가 Replit 주소를 가리키지 않는다

### 보안 (이 기회에 같이)

- [ ] `JWT_SECRET`을 새 값으로 바꿨다 (예전 기본값이 공개 저장소에 노출돼 있었다)
- [ ] Neon DB 비밀번호를 회전했다 (Neon 콘솔 → Roles → Reset password →
      새 connection string을 Railway에 반영). Replit이 쥐고 있던 자격증명을 무효화하는 것.
- [ ] `ADMIN_PASSWORD`가 추측 가능한 값이 아니다
- [ ] `.env`가 커밋돼 있지 않다 (`git ls-files | grep .env` → `.env.example`만 나와야 함)

### 해지 후 대비

- [ ] 해지 뒤 **첫 24시간 동안 하루 한 번** 운영 사이트 로그인을 해 본다
- [ ] 옛 DB(Replit 소유)는 최소 2주 뒤에 정리한다 — 되돌릴 여지를 남긴다

---

## 부록 — 이번에 바뀐 파일

| 파일 | 변경 |
|------|------|
| `client/index.html` | replit.com 배너 스크립트 제거 |
| `server/middleware/auth.ts` | 공개된 고정 JWT 기본값 → 부팅 시 무작위 키 |
| `server/index.ts` | 시작 경고 문구를 실제 동작에 맞게 수정 |
| `.gitignore` | `.local/` 추가 |
| `.replit` | 삭제 |
| `.local/**` (188개) | 추적 해제 |
| `replit.md` → `ARCHITECTURE.md` | 개명 |
| `railway.env.example` → `.env.example` | 개명 + 설명 보강 |
| `Dockerfile`, `.dockerignore` | 신규 — 아무 도커 환경에서 실행 |
| `package.json` | `engines.node >=20`, `db:verify` 스크립트 |
| `scripts/db-verify.ts` | 신규 — 이관 전후 데이터 대조 |
| `DEPLOY_RAILWAY.md` | Replit Secrets 안내 → Neon 콘솔 안내 |
