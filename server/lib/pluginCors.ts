/**
 * Toss Front 단말기 / 플러그인용 CORS.
 *
 * 왜 별도 모듈인가:
 *   2026-08 "단말기 등록 실패" 는 서버에 로그 한 줄 남기지 않았다. 웹뷰가 CORS 로
 *   요청을 아예 보내지 않았기 때문이다. 이렇게 "서버에서는 안 보이는" 규칙일수록
 *   테스트로 고정해 둬야 한다. index.ts 안에 인라인으로 두면 서버를 통째로 띄우지
 *   않고는 검증할 수 없어서, 규칙만 여기로 분리했다.
 */

import type { Request, Response, NextFunction } from "express";

/** 개발자센터가 부여하는 플러그인 실행 origin. (문서: https://[appName].plugin.tossplace.com) */
export const TOSS_PLUGIN_ORIGIN =
  /^https:\/\/[A-Za-z0-9-]+\.plugin(?:-dev)?\.tossplace\.com$/;

/**
 * 단말기(Front 플러그인)가 직접 부르는 "기계 API" 인가?
 *
 * /admin 은 제외한다. 그쪽은 원장 쿠키(authGuard)로 보호되는 사람용 화면 API 라
 * 성격이 다르다. 같은 prefix 를 쓴다는 이유만으로 함께 열 이유가 없다.
 */
export function isDeviceApi(path: string): boolean {
  return path.startsWith("/api/toss-front/") && !path.startsWith("/api/toss-front/admin");
}

/**
 * 단말기 경로는 origin 을 가리지 않고, 그 밖에는 Toss 플러그인 origin 만 허용한다.
 *
 * 왜 단말기 경로를 * 로 여는가:
 *   origin 을 좁게 잡아 두면, 우리가 예상한 origin 이 아닐 때 요청이 서버에 닿기도
 *   전에 웹뷰가 막는다. 그러면 단말기에는 "서버에 연결하지 못했습니다" 라는 말만 남고
 *   서버 로그에는 아무 흔적도 없다. 원인을 볼 수 없는 실패가 된다.
 *
 * 왜 * 가 안전한가:
 *   이 경로들은 쿠키를 쓰지 않는다. 인증은 body 의 deviceKey 또는 Authorization
 *   Bearer 토큰이다. CORS 가 막아 주는 건 "브라우저가 피해자의 쿠키를 자동으로 실어
 *   보내는 것" 뿐인데 여기엔 그런 게 없다. 공격자가 curl 로 부르는 건 CORS 로 막을 수
 *   없고 원래도 막지 못했다 — 그건 deviceGuard 가 막는다. 즉 좁은 allowlist 는 보안을
 *   준 적이 없고 정상 단말기만 막고 있었다.
 *
 * Allow-Credentials 는 절대 켜지 않는다. * 와 함께 쓰면 브라우저가 거부하고,
 * 켜는 순간 위의 "안전한 이유"가 통째로 무너진다.
 */
export function pluginCors(req: Request, res: Response, next: NextFunction) {
  if (isDeviceApi(req.path)) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && TOSS_PLUGIN_ORIGIN.test(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  return next();
}
