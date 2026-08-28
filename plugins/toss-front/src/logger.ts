/**
 * 플러그인 라이프사이클 로거.
 *
 * 왜 console 만으로 부족했나:
 *   Front 단말기는 개발자도구를 붙일 수 없다. 0.2.x 에서 실패 경로가 전부
 *   console.error 였는데, 현장에서는 그 로그를 볼 방법이 없어 "검은 화면"이라는
 *   증상만 남고 원인은 통째로 사라졌다. 단말기 로그 서버에도 연결 로그만 찍혔다.
 *
 * 그래서 세 곳에 동시에 남긴다:
 *   1) console        — 혹시 붙일 수 있는 환경을 위해
 *   2) 화면 진단줄     — SDK 유휴화면을 못 띄운 상황에서 원장이 눈으로 읽을 최후 수단
 *   3) EduSyncPro 서버 — /api/toss-front/plugin-logs (원장 화면 + Railway 로그)
 *
 * 서버 전송은 배치다. 부팅 직후 초당 여러 줄이 쏟아지는데 그때마다 fetch 를 날리면
 * 정작 중요한 세션 요청과 경쟁한다. 700ms 간격으로 모아 한 번에 보낸다.
 * 전송 실패는 삼킨다 — 로그를 못 보내는 것 때문에 결제가 막히면 본말전도다.
 */

export type LogLevel = "info" | "warn" | "error";

interface QueuedEntry {
  level: LogLevel;
  event: string;
  message: string;
  at: string;
}

const PLUGIN_VERSION = "0.3.2";
const FLUSH_INTERVAL_MS = 700;
const MAX_QUEUE = 200;

let serverUrl = "";
let deviceIdHint: string | null = null;
let queue: QueuedEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let onScreenSink: ((line: string, level: LogLevel) => void) | null = null;

export function configureLogger(opts: {
  serverUrl: string;
  onScreen?: (line: string, level: LogLevel) => void;
}) {
  serverUrl = opts.serverUrl;
  onScreenSink = opts.onScreen ?? null;
}

export function setLogDeviceId(id: string | null) {
  deviceIdHint = id;
}

function enqueue(level: LogLevel, event: string, message: string) {
  const at = new Date().toISOString();
  queue.push({ level, event, message, at });
  // 서버가 죽어 있어도 메모리가 무한히 늘지 않도록 앞에서부터 버린다.
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);

  const line = `[EduSyncPro]${level === "error" ? "[ERROR]" : level === "warn" ? "[WARN]" : ""} ${event}${
    message ? " — " + message : ""
  }`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  onScreenSink?.(line, level);

  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

async function flush() {
  flushTimer = null;
  if (queue.length === 0 || !serverUrl) return;
  const batch = queue;
  queue = [];
  try {
    await fetch(`${serverUrl}/api/toss-front/plugin-logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: deviceIdHint,
        pluginVersion: PLUGIN_VERSION,
        entries: batch.map((e) => ({
          level: e.level,
          event: e.event,
          message: e.message,
          at: e.at,
        })),
      }),
    });
  } catch {
    // 전송 실패한 배치는 버린다. 재시도 큐를 두면 서버 장애 시 큐가 계속 부풀고
    // 복구 시점에 한꺼번에 몰려 되레 해롭다. 화면·console 에는 이미 남아 있다.
  }
}

/**
 * 에러 객체에서 사람이 읽을 수 있는 한 줄을 뽑는다.
 * stack 을 함께 담되 너무 길면 자른다 (서버 스키마가 1000자로 제한).
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const stack = (err.stack || "").split("\n").slice(0, 4).join(" | ");
    return `${err.name}: ${err.message} :: ${stack}`.slice(0, 900);
  }
  try {
    return String(err).slice(0, 900);
  } catch {
    return "알 수 없는 오류";
  }
}

export const log = {
  info: (event: string, message = "") => enqueue("info", event, message),
  warn: (event: string, message = "") => enqueue("warn", event, message),
  error: (event: string, err: unknown, context = "") =>
    enqueue("error", event, `${context ? context + " :: " : ""}${describeError(err)}`),
  /** 프로세스가 끝나기 전에 남은 로그를 밀어낸다. */
  flushNow: () => flush(),
};

/**
 * 잡히지 않은 예외·거부를 전부 서버로 보낸다.
 *
 * 0.2.x 의 검은 화면이 정확히 이 자리에서 사라졌다. bootstrap() 이 던진 예외가
 * console.error 한 줄로 끝나고 아무 데도 남지 않았다.
 */
export function installGlobalErrorHandlers() {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    enqueue(
      "error",
      "uncaught error",
      `${e.message} @ ${e.filename ?? "?"}:${e.lineno ?? 0}:${e.colno ?? 0}`
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    enqueue("error", "unhandled rejection", describeError((e as PromiseRejectionEvent).reason));
  });
}
