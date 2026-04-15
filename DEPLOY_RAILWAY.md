# EduSyncPro — Railway 배포 가이드

> 이 파일은 마이그레이션 완료 후 삭제해도 됩니다.

---

## 코드 수정 완료 내역 (이미 적용됨)

| 파일 | 변경 내용 |
|------|-----------|
| `vite.config.ts` | Replit 전용 플러그인 2개 제거 |
| `package.json` | `@replit/vite-plugin-*` devDependencies 2개 제거 |
| `.gitignore` | `.env`, `cookies*.txt`, Replit 파일 추가 |
| `railway.env.example` | Railway에 등록할 환경변수 목록 |

> ✅ Port(`process.env.PORT`), Host(`0.0.0.0`), Build/Start 명령어는 이미 완벽히 설정되어 있었음.  
> ✅ DB는 NeonDB(외부 PostgreSQL)라 데이터 마이그레이션 불필요.

---

## STEP 1 — DATABASE_URL 복사 (Replit → 메모장)

```
Replit 프로젝트 → Tools → Secrets → DATABASE_URL 값 복사해두기
```

---

## STEP 2 — GitHub 저장소 생성 및 코드 업로드

```bash
# EduSyncPro 폴더에서 실행 (Git Bash 또는 터미널)

cd C:\Users\Administrator\Documents\EduSyncPro

# 기존 Replit remote 제거 후 새 GitHub remote 연결
git remote remove origin   # 이미 origin이 있으면 제거

# GitHub에서 새 저장소 생성: https://github.com/new
# 저장소명: EduSyncPro (Private 권장)
# 생성 후 아래 명령어 실행 (YOUR_USERNAME 교체)
git remote add origin https://github.com/YOUR_USERNAME/EduSyncPro.git

# 현재 변경사항 커밋
git add .
git commit -m "chore: Railway 마이그레이션 - Replit 플러그인 제거 및 설정 최적화"

# GitHub에 푸시
git branch -M main
git push -u origin main
```

---

## STEP 3 — Railway 프로젝트 생성 및 배포

```
1. https://railway.app 접속 → Login (GitHub으로 로그인)
2. New Project → Deploy from GitHub repo
3. EduSyncPro 저장소 선택
4. Branch: main → Deploy Now
```

---

## STEP 4 — Railway 환경변수 설정

```
Railway 대시보드 → EduSyncPro 서비스 클릭
→ Variables 탭 → RAW Editor 클릭
→ 아래 3줄 붙여넣기 (값 교체 필수)
```

```
DATABASE_URL=postgresql://...neon.tech/dbname?sslmode=require
JWT_SECRET=<32자_이상_랜덤_문자열>
NODE_ENV=production
```

JWT_SECRET 생성 (PowerShell):
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

→ **Update Variables** 클릭 → 자동 재배포 시작

---

## STEP 5 — 배포 URL 확인 및 헬스체크

```
Railway 대시보드 → Settings → Domains → Generate Domain
→ 생성된 URL 복사 (예: edusyncpro-production.up.railway.app)
```

터미널에서 확인:
```bash
# 앱 응답 확인
curl -I https://edusyncpro-production.up.railway.app

# 로그인 API 테스트
curl -X POST https://edusyncpro-production.up.railway.app/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"yourpassword"}' \
  -c cookies_test.txt \
  -s | python3 -m json.tool
```

---

## STEP 6 — 이후 배포 워크플로우 (자동)

```
코드 수정 → git add . → git commit → git push origin main
→ Railway 자동 빌드/배포 (약 2~3분)
```

---

## 배포 완료 체크리스트

```
[ ] Railway URL로 메인 페이지 접속 성공
[ ] 로그인 정상 작동 (기존 계정 사용 가능)
[ ] 학생 목록 조회 (NeonDB 연결 확인)
[ ] 수강료 입력/저장 정상 작동
[ ] Railway Logs에서 에러 없음 확인
[ ] Replit 구독 해지
```

---

## Replit 구독 해지 시점

✅ 위 체크리스트 모두 통과 후 → Replit Account → Billing → Cancel Plan
