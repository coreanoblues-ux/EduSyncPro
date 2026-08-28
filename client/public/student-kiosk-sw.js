/**
 * PageOne 학생용 수납 화면 전용 Service Worker.
 *
 * 왜 필요한가:
 *   Android Chrome 이 홈 화면 아이콘 → standalone 창으로 열려면 (installable PWA)
 *   최소한의 service worker 가 등록되어 있어야 한다. 이 SW 는 그 조건을 채우는
 *   최소 구성이며, 오프라인 캐시나 결제 응답 캐시는 절대 하지 않는다.
 *
 * 캐시 정책 (매우 중요):
 *   - /api/*                → 절대 캐시 금지. 항상 네트워크만 사용.
 *   - HTML 문서             → 네트워크 우선 (오프라인이면 실패시켜서 원장이 인지)
 *   - 정적 자산(JS/CSS/폰트) → 있으면 캐시에서, 없으면 네트워크 (stale-while-revalidate)
 *
 * 왜 결제 경로는 캐시하지 않나:
 *   결제 상태(폴링 응답, dispatch 결과)를 오래된 캐시로 돌려주면 완료된 결제를
 *   미완료로 보이게 하거나, 이미 취소된 결제를 진행중으로 표시할 수 있다. 학원 회계
 *   기록이 걸린 화면이라 안전한 쪽은 항상 "네트워크가 진실" 이다.
 *
 * scope 는 등록 시 '/student-kiosk' 로 좁힌다. 원장 페이지·수업 페이지 등
 * EduSyncPro 의 다른 화면에는 영향을 주지 않는다.
 */

const VERSION = "v1";
const STATIC_CACHE = `pageone-kiosk-static-${VERSION}`;

// 설치 시엔 아무것도 미리 캐시하지 않는다. 첫 화면 로드 후 자연스럽게 필요한 것만 담긴다.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("pageone-kiosk-") && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // POST/PUT 등은 SW 가 절대 개입하지 않는다

  const url = new URL(request.url);

  // 다른 오리진 (구글 폰트 등) 은 SW 를 우회
  if (url.origin !== self.location.origin) return;

  // /api/* : 절대 캐시하지 않는다 (결제·세션·학생 데이터)
  if (url.pathname.startsWith("/api/")) {
    return; // 브라우저 기본 네트워크 fetch 로 위임
  }

  // 매니페스트·SW 자기 자신 : 항상 네트워크
  if (
    url.pathname === "/student-kiosk-sw.js" ||
    url.pathname === "/student-kiosk.webmanifest"
  ) {
    return;
  }

  // HTML 네비게이션 : 네트워크 우선, 실패 시에만 캐시 폴백
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(STATIC_CACHE);
          cache.put(request, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cached = await caches.match(request);
          return cached || new Response("오프라인입니다.", {
            status: 503,
            headers: { "content-type": "text/plain;charset=utf-8" },
          });
        }
      })()
    );
    return;
  }

  // JS/CSS/폰트/이미지 : stale-while-revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(request);
      const networkPromise = fetch(request)
        .then((resp) => {
          if (resp.ok) cache.put(request, resp.clone()).catch(() => {});
          return resp;
        })
        .catch(() => cached);
      return cached || networkPromise;
    })()
  );
});
