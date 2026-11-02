"use client";

import { useState } from "react";
import { flash } from "@/lib/store";

const key = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** 태그 입력: Enter·쉼표로 추가, ×로 삭제, 칸이 비었을 때 Backspace는 마지막 태그 삭제. 칸을 벗어나면 입력 중이던 말도 추가 */
export default function TagInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const words = draft.split(/[,，]/).map((w) => w.trim()).filter(Boolean);
    if (!words.length) {
      setDraft("");
      return;
    }
    const next = [...value];
    let tooShort = false;
    for (const w of words) {
      if (key(w).length < 2) tooShort = true; // 한 글자는 치환하면 다른 단어까지 망가짐 (normalizeGlossary 규칙)
      else if (!next.some((t) => key(t) === key(w))) next.push(w);
    }
    onChange(next);
    setDraft("");
    if (tooShort) flash("자주 틀리는 형태는 두 글자 이상만 등록할 수 있어요.");
  };

  return (
    <div className="taginput">
      {value.map((t) => (
        <span className="chip" key={t}>
          {t}
          <button type="button" aria-label={`${t} 삭제`} onClick={() => onChange(value.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // 한글 조합 중 Enter는 조합만 끝내는 키 입력이라 무시 (안 그러면 글자가 잘리거나 두 번 추가됨)
          if (e.nativeEvent.isComposing) return;
          if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder={value.length ? "" : placeholder}
        autoComplete="off"
        enterKeyHint="next"
      />
    </div>
  );
}
