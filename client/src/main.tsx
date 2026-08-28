import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);

/**
 * PWA service worker 등록.
 *
 * 원장 화면·수업 화면 등 다른 경로에는 SW 를 붙이지 않는다. 이유:
 *   - 관리자 화면은 실시간 정합성이 더 중요하고 (오래된 캐시가 회계 화면에 뜨면 위험)
 *   - SW 는 한 번 등록되면 그 origin 전체 fetch 를 가로챌 잠재력이 있어, 넓게 붙이면
 *     디버깅과 배포 롤백이 어려워진다.
 *
 * /student-kiosk 로 진입한 세션에서만 등록하고, scope 도 그 경로로 좁혀 놓았다.
 * 이 화면을 홈에 추가한 태블릿은 다음 부팅부터 standalone 창으로 열린다.
 */
if ("serviceWorker" in navigator && window.location.pathname.startsWith("/student-kiosk")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/student-kiosk-sw.js", { scope: "/student-kiosk" })
      .catch((err) => {
        // 등록 실패해도 화면 자체는 정상 동작해야 한다 (PWA 는 부가기능).
        console.warn("[PageOne] service worker 등록 실패:", err);
      });
  });
}
