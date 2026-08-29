/**
 * async 라우트가 던진 예외를 Express 에러 핸들러로 흘려보낸다.
 *
 * 왜 필요한가 (2026-08 실제 장애):
 *   단말기 등록 한 번 눌렀더니 학원 전체가 멈췄다. 원인은 DB에 페어링 컬럼이
 *   없어서 INSERT 가 실패한 것인데, 문제는 그 다음이었다.
 *
 *   Express 4 는 async 핸들러를 이렇게 호출한다:
 *       layer.handle(req, res, next)      // 반환값(Promise)을 그냥 버린다
 *   핸들러가 async 면 예외는 throw 되는 게 아니라 Promise 를 reject 시킨다.
 *   Express 는 그 Promise 를 쳐다보지 않으므로 next(err) 가 불리지 않고,
 *   전역 에러 미들웨어도 영영 호출되지 않는다. 아무도 안 잡은 rejection 은
 *   Node 15+ 에서 기본적으로 프로세스를 종료시킨다 (이 서버는 Node 24).
 *
 *   결과: 요청 하나의 SQL 오류가 곧바로 컨테이너 전체 종료 → Railway 502.
 *   원장 입장에서는 "등록 버튼을 눌렀더니 프로그램이 통째로 죽었다"가 된다.
 *   수납·출결·학생조회까지 같이 멈추므로, 이건 버그가 아니라 사고에 가깝다.
 *
 * 무엇을 하는가:
 *   express.Route 의 메서드(get/post/put/...)를 감싸서, 등록되는 모든 핸들러의
 *   반환값이 Promise 면 .catch(next) 를 붙인다. 그러면 실패가 정상적으로
 *   에러 미들웨어까지 흘러가 500 JSON 응답이 되고, 프로세스는 살아 있다.
 *
 * 왜 라우트를 85개 직접 고치지 않았나:
 *   지금 있는 85개를 다 고쳐도 내일 추가되는 86번째가 또 빠진다. 사람이 매번
 *   기억해야 하는 안전장치는 언젠가 반드시 뚫린다. 등록 지점 한 곳에서 강제한다.
 *
 * 왜 express-async-errors 패키지를 안 쓰나:
 *   그 패키지는 express/lib/router/layer 라는 내부 경로를 직접 import 한다.
 *   express 가 내부 구조를 바꾸면 조용히 깨진다. express.Route 는 공개 export 라
 *   (express.js 의 `exports.Route = Route`) 훨씬 덜 위험하다. 의존성도 안 늘린다.
 *
 * 한계:
 *   app.use(...) 로 전역에 붙인 async 미들웨어는 Route 를 거치지 않아 감싸지지
 *   않는다. 라우트에 인자로 넘기는 미들웨어(authGuard 등)는 Route 스택에 들어가므로
 *   감싸진다. 전역 미들웨어까지 포함한 최후의 방어선은 index.ts 의
 *   unhandledRejection 핸들러가 맡는다.
 *
 * 설치 시점:
 *   이 모듈은 import 되는 즉시(파일 맨 아래에서) 스스로 설치한다. 함수를 export 해서
 *   index.ts 본문에서 부르는 방식은 쓸 수 없다 — ESM 은 모든 import 를 먼저 평가한 뒤에
 *   본문을 실행하므로, 그 호출은 라우트가 전부 등록된 "뒤"에 일어나 아무 효과가 없다.
 *   따라서 server/index.ts 에서는 ./routes 보다 위에 `import "./lib/asyncErrors"` 만 둔다.
 */

import express from "express";

type Handler = (...args: any[]) => any;

const WRAPPED = Symbol("asyncWrapped");

function wrap(fn: Handler): Handler {
  if (typeof fn !== "function" || (fn as any)[WRAPPED]) return fn;

  // Express 는 fn.length 로 "에러 핸들러(4개 인자)"인지 판별한다.
  // 감싼 함수도 인자 개수를 똑같이 맞춰야 그 판별이 유지된다.
  const wrapped: Handler =
    fn.length === 4
      ? function (this: any, err: any, req: any, res: any, next: any) {
          try {
            const out = fn.call(this, err, req, res, next);
            if (out && typeof out.catch === "function") out.catch(next);
            return out;
          } catch (e) {
            next(e);
          }
        }
      : function (this: any, req: any, res: any, next: any) {
          try {
            const out = fn.call(this, req, res, next);
            if (out && typeof out.catch === "function") out.catch(next);
            return out;
          } catch (e) {
            next(e);
          }
        };

  // 이름을 살려 둔다. 스택 트레이스에 anonymous 만 찍히면 진단이 어려워진다.
  Object.defineProperty(wrapped, "name", { value: fn.name || "asyncHandler" });
  (wrapped as any)[WRAPPED] = true;
  return wrapped;
}

function wrapAll(handlers: any[]): any[] {
  return handlers.map((h) => (Array.isArray(h) ? h.map(wrap) : wrap(h)));
}

let installed = false;

/** Express 라우트 등록 지점에 래퍼를 심는다. 여러 번 불러도 한 번만 적용된다. */
export function installAsyncErrorHandling(): void {
  if (installed) return;
  installed = true;

  const RouteProto: any = (express as any).Route?.prototype;
  if (!RouteProto) {
    // 여기 오면 express 구조가 바뀐 것이다. 죽이지는 않되 크게 알린다.
    console.error(
      "❌ express.Route 를 찾지 못해 async 오류 보호를 설치하지 못했습니다. " +
        "async 라우트가 실패하면 프로세스가 종료될 수 있습니다."
    );
    return;
  }

  const METHODS = [
    "all", "get", "post", "put", "delete", "patch",
    "head", "options",
  ];

  for (const m of METHODS) {
    const original = RouteProto[m];
    if (typeof original !== "function") continue;
    RouteProto[m] = function (this: any, ...handlers: any[]) {
      return original.apply(this, wrapAll(handlers));
    };
  }
}

// import 되는 즉시 설치한다. (이유는 파일 상단 "설치 시점" 주석 참고)
installAsyncErrorHandling();
