# EduSyncPro 작업 규칙

## 시작할 때 / 끝낼 때
1. **작업 전 [PLAN.md](PLAN.md)를 읽는다.** 무엇을 왜 만드는지, 이미 있는 기능이 무엇인지 거기 있다.
2. **작업 전 `git fetch` 후 `origin/main`과 비교한다.** 원장은 집 PC와 학원 PC 양쪽에서 작업한다.
3. **작업이 끝나면 PLAN.md 맨 아래 '진행 기록'에 한 줄 남긴다.** (날짜 · 한 일 · 다음 할 일)

## 이 앱은 운영 중이다
실제 학생·상담·결제 데이터가 들어 있다. Railway + Neon Postgres로 돌아가고,
GitHub `main`에 푸시하면 바로 배포된다. 로컬 `npm run dev`로 먼저 확인하고 승인을 받은 뒤 푸시한다.

## 절대 규칙

### DB 칼럼 추가를 `drizzle-kit push`에 맡기지 않는다
`scripts/migrate-add-*.ts` 전용 스크립트를 만들고 `railway.toml`의 `preDeployCommand` 끝에 이어 붙인다.
여러 번 돌아도 안전해야 한다 (`IF NOT EXISTS`).

> 근거: 과거 `tenants.share_phone` 한 칸을 push에 맡겼다가 **로그인이 통째로 죽었다.**
> Drizzle은 SELECT에 칼럼명을 하나하나 적기 때문에, 스키마에만 있고 DB에 없는 칼럼이 하나라도
> 생기면 그 테이블을 읽는 모든 경로가 같이 죽는다. 배포는 초록색으로 끝나서 더 위험하다.
> 자세한 내용은 `railway.toml` 주석 5)번.

### pgEnum을 새로 만들거나 값을 추가하지 않는다
push가 데이터 손실 우려로 대화형 확인을 요구해 배포가 멈춘다. `text` 칼럼 + zod 검증으로 처리한다.

### 토스 결제 경로와 `edusyncpro-production-dcfe.up.railway.app` 도메인은 건드리지 않는다
수납 태블릿이 이 주소에 물려 있고, 토스 개발자센터 ACL에 등록된 유일한 주소다.
커스텀 도메인을 붙이더라도 이 주소는 **함께 살려 둔다.**

### `.env`는 커밋하지 않는다
`.env.example`만 갱신한다.

## 코드 관례
- 멀티테넌트: 모든 쿼리에 `tenantId` 필터. 라우트는 `authGuard → tenantGuard → roleGuard → validateBody` 순
- 날짜는 **`YYYY-MM-DD` 문자열**로 저장한다. `timestamp`를 쓰면 UTC로 저장돼 한국 시각 밤에
  적은 것이 전날로 뜬다 (`tasks.dueDate`가 그래서 text다). 헬퍼는 `shared/day.ts`
- 주석은 "무엇"이 아니라 **"왜"**를 적는다. 이 저장소의 기존 주석이 그 기준이다
- 한국어로 쓴다. 화면 문구는 원장이 바로 읽는 말로
