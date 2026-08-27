/**
 * 프론트 단말기별 SSE 채널 매니저.
 *
 * 각 tossDeviceId 하나마다 여러 개의 열린 SSE 응답 스트림을 가질 수 있다
 * (탭 재열림·재접속 순간의 중첩). 새 dispatch가 생기면 그 device의 모든 스트림에 push.
 *
 * heartbeat 20초: Railway·프록시가 유휴 연결을 끊지 않도록 주기적으로 comment 라인을 보낸다.
 *
 * 프로세스 재시작 시 열린 스트림은 모두 끊긴다. 프론트는 EventSource 자동 재연결로
 * 복구하고, 재접속 첫 헬로 이벤트에 자기 device의 PENDING dispatch가 있으면 서버가 즉시 push.
 */

import type { Response } from "express";

interface Subscriber {
  res: Response;
  keepAliveTimer: NodeJS.Timeout;
}

const channels: Map<string, Set<Subscriber>> = new Map();

const HEARTBEAT_MS = 20_000;

export function subscribe(tossDeviceId: string, res: Response): () => void {
  // SSE 헤더는 호출 측에서 이미 세팅했다는 가정.
  const keepAliveTimer = setInterval(() => {
    // ": ping\n\n" 은 EventSource가 무시하는 comment 라인. 유휴 종료 방지 용도.
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // 이미 끊긴 응답에 쓰기 실패하면 unsubscribe에서 정리된다.
    }
  }, HEARTBEAT_MS);

  const sub: Subscriber = { res, keepAliveTimer };
  let set = channels.get(tossDeviceId);
  if (!set) {
    set = new Set();
    channels.set(tossDeviceId, set);
  }
  set.add(sub);

  const unsubscribe = () => {
    clearInterval(keepAliveTimer);
    const s = channels.get(tossDeviceId);
    if (s) {
      s.delete(sub);
      if (s.size === 0) channels.delete(tossDeviceId);
    }
  };

  res.on("close", unsubscribe);
  return unsubscribe;
}

export function publish(tossDeviceId: string, event: string, data: any): number {
  const set = channels.get(tossDeviceId);
  if (!set || set.size === 0) return 0;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let delivered = 0;
  set.forEach((sub) => {
    try {
      sub.res.write(payload);
      delivered++;
    } catch {
      // 응답 실패는 close 이벤트로 곧 정리됨
    }
  });
  return delivered;
}

export function subscriberCount(tossDeviceId: string): number {
  return channels.get(tossDeviceId)?.size ?? 0;
}
