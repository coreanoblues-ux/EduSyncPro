/**
 * 입력 중인 글자를 자기 상태로 들고 있는 칸.
 *
 * ── 왜 필요한가 (2026-11-07 원장 제보: "한마디 칸에 글씨가 두 번씩 눌린다") ──
 *   이 화면의 칸들은 값을 react-query 캐시에서 읽는다(자동 저장 때문에). 그런데 캐시를 고치면
 *   화면에 값이 **한 박자 늦게**(다음 틱) 돌아온다. 그 사이 React 는 칸을 옛 값으로 되돌린다.
 *   영어·숫자는 티가 안 나지만, 한글은 자모를 조합하는 중이라 되돌림에 걸려 글자가 겹친다.
 *
 *   그래서 칸이 입력 중인 값을 스스로(동기 상태로) 들고, 바깥 값은 **칸이 비활성일 때만** 받아들인다.
 *   (한마디 빠른 입력 버튼처럼 바깥에서 값을 바꾸는 경우는 버튼을 누르는 순간 칸이 이미 비활성이다.)
 */

import { forwardRef, useEffect, useRef, useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";

type Props = Omit<ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: string | number | null | undefined;
  onValueChange: (v: string) => void;
};

const LocalInput = forwardRef<HTMLInputElement, Props>(function LocalInput({ value, onValueChange, onFocus, onBlur, ...rest }, ref) {
  const outer = value == null ? "" : String(value);
  const [local, setLocal] = useState(outer);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setLocal(outer);
  }, [outer]);

  return (
    <Input
      {...rest}
      ref={ref}
      value={local}
      onFocus={(e) => {
        focused.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        // 칸을 떠날 때 바깥 값으로 맞춘다 (예: 101 을 쳤으면 100 으로 고쳐진 값을 보여 준다).
        setLocal(outer);
        onBlur?.(e);
      }}
      onChange={(e) => {
        setLocal(e.target.value);
        onValueChange(e.target.value);
      }}
    />
  );
});

export default LocalInput;
