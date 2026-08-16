# EduSyncPro — 어디서든 도는 표준 Node 컨테이너.
# "Railway마저 못 쓰게 됐을 때 옮길 수 있다"는 보험이다. 저장소 루트에서:
#
#   docker build -f docker/Dockerfile -t edusync .
#   docker run -p 3000:3000 --env-file .env edusync
#
# ⚠️ 이 파일을 저장소 루트로 옮기지 말 것.
# railway.toml에 builder = "NIXPACKS"라고 써 두면 Railway가 이 파일을 무시할
# 줄 알았는데 아니었다. 루트에 Dockerfile이 있으면 Railway가 그걸 먼저 쓴다.
# 그러면 아래 런타임 스테이지가 배포되는데, 여기엔 devDependencies도
# drizzle.config.ts도 shared/schema.ts도 없어서 railway.toml의
# preDeployCommand("npm run db:push")가 죽는다. 실제로 2026-08-16에 배포가
# 네 번 연속 Pre-deploy에서 실패했다. (직전 빌드가 계속 떠 있어 운영은 무사했다.)

# ── 1단계: 빌드 ────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# 소스보다 매니페스트를 먼저 복사해야 의존성 레이어가 캐시된다.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# devDependencies는 런타임에 필요 없다. 여기서 덜어내면 최종 이미지가 가볍다.
RUN npm prune --omit=dev

# ── 2단계: 실행 ────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# root로 돌릴 이유가 없다.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# server/index.ts가 process.env.PORT를 읽고 없으면 3000을 쓴다.
EXPOSE 3000
CMD ["node", "dist/index.js"]
