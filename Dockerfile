# EduSyncPro — 어디서든 도는 표준 Node 컨테이너.
#
# Railway는 railway.toml에서 NIXPACKS를 쓰라고 지정해 두었으므로 이 파일을
# 무시한다. 이건 "Railway마저 못 쓰게 됐을 때 다른 곳으로 옮길 수 있다"는
# 보험이다. 아무 도커 환경에서나:
#   docker build -t edusync .
#   docker run -p 3000:3000 --env-file .env edusync

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
