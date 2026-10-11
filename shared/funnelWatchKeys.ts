/**
 * 자동으로 적은 할 일에 찍는 도장.
 *
 * ── 왜 도장이 필요한가 ──
 *   놓친 자리 찾기(shared/funnelWatch.ts)는 **하루 한 번이 아니라, 서버가
 *   켜질 때마다** 돈다. Railway 는 배포할 때마다 서버를 다시 켜므로, 하루에
 *   다섯 번 배포하면 다섯 번 돈다. 도장이 없으면 같은 할 일이 다섯 줄 쌓인다.
 *
 *   그리고 원장이 "이건 지금 안 할 일"이라고 지웠거나 이미 처리해 완료로
 *   표시한 줄을, 다음 날 아무 일 없었던 것처럼 다시 적으면 안 된다. 그렇게
 *   한 번 데면 원장은 자동으로 생긴 할 일을 전부 무시하게 되고, 그 순간 이
 *   기능은 쓸모가 없어진다.
 *
 * ── 왜 새 표나 새 칸을 만들지 않는가 ──
 *   할 일 표(tasks)에 이미 source_text 칸이 있다. 사람이 AI 입력으로 만든
 *   할 일은 여기에 원문이 들어가고, 화면에는 표시되지 않는다. 자동으로 만든
 *   줄은 여기에 "auto:<도장>" 을 적어 둔다. 표 구조를 바꾸지 않으므로
 *   마이그레이션이 필요 없고, 되돌리기도 쉽다(그 줄만 지우면 끝).
 */

const PREFIX = "auto:";

/** 도장을 tasks.source_text 에 넣을 문자열로. */
export function autoSourceText(key: string): string {
  return PREFIX + key;
}

/** tasks.source_text 에서 도장을 꺼낸다. 사람이 적은 원문이면 null. */
export function parseAutoKey(sourceText: string | null | undefined): string | null {
  if (!sourceText || !sourceText.startsWith(PREFIX)) return null;
  return sourceText.slice(PREFIX.length);
}

/**
 * 아직 적지 않은 줄만 골라낸다.
 *
 * existingSourceTexts 에는 그 학원의 **모든** 할 일의 source_text 를 넣는다
 * (완료된 것까지 포함). 완료 여부를 가리지 않는 이유는 위 주석 참조.
 */
export function pickNewAlerts<A extends { key: string }>(
  alerts: readonly A[],
  existingSourceTexts: readonly (string | null | undefined)[]
): A[] {
  const used = new Set<string>();
  for (const s of existingSourceTexts) {
    const key = parseAutoKey(s);
    if (key) used.add(key);
  }
  return alerts.filter((a) => !used.has(a.key));
}
