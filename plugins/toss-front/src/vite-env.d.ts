/**
 * 자산 import 타입 선언.
 *
 * tsconfig 의 `types: []` 때문에 vite/client 타입이 들어오지 않는다. 그 설정은
 * 의도된 것이다 — 이 번들은 단말기 웹뷰에서 돌고, 노드/전역 타입이 섞여 들어오면
 * 여기서는 존재하지 않는 API 를 타입만 보고 쓰게 된다. 이 저장소에서 이미 세 번
 * 겪은 사고가 정확히 그 형태다("타입 선언은 사실이 아니라 주장이다").
 *
 * 그래서 필요한 최소한만 직접 적는다. png 는 Vite 가 빌드 시 해시 파일명으로
 * 산출하고 그 상대경로(`./assets/...`) 문자열을 반환한다. vite.config 의
 * `base: "./"` 덕분에 ZIP 이 어느 하위 경로에 배포돼도 로드된다.
 */
declare module "*.png" {
  const src: string;
  export default src;
}
