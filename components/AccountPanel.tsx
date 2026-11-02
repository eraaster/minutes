"use client";

import { useEffect, useRef, useState } from "react";
import { closeAccount, flash, saveAccount, useStore } from "@/lib/store";

const GROQ_KEYS_URL = "https://console.groq.com/keys";
const KEY_RE = /^gsk_[A-Za-z0-9]{20,}$/;

/** 계정 설정: PC는 오른쪽 슬라이드 패널, 모바일은 아래에서 올라오는 시트 */
export default function AccountPanel() {
  const focusOn = useStore((s) => s.accountOpen);
  const account = useStore((s) => s.account);
  const open = focusOn !== null;

  // 입력값(초안) → 저장(Enter/버튼) 시 적용
  const [author, setAuthor] = useState("");
  const [key, setKey] = useState("");
  const [pw, setPw] = useState("");
  const [lang, setLang] = useState("ko");
  const [background, setBackground] = useState("");
  const [showKey, setShowKey] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setAuthor(account.author);
    setKey(account.groqKey);
    setPw(account.pw);
    setLang(account.lang);
    setBackground(account.background);
    setShowKey(false);
    const before = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => document.getElementById(focusOn === "key" ? "groq-key" : "mm-author")?.focus(), 60);
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(t);
      document.body.style.overflow = bodyOverflow;
      before?.focus?.();
    };
    // 열릴 때 한 번만 초안을 채움 (저장값이 바뀌어도 입력 중인 초안을 덮지 않게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") closeAccount();
    if (e.key !== "Tab") return;
    // 패널 안에서만 Tab 순환
    const items = panelRef.current?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input,select,textarea");
    if (!items?.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const keyBad = !!key.trim() && !KEY_RE.test(key.trim());
  const dirty = author !== account.author || key !== account.groqKey || pw !== account.pw || lang !== account.lang || background !== account.background;

  const save = () => {
    if (keyBad) {
      document.getElementById("groq-key")?.focus();
      return;
    }
    const a = author.trim();
    const k = key.trim();
    saveAccount({ author: a, groqKey: k, pw, lang, background: background.trim() });
    closeAccount();
    const who = a ? `${a}님` : "설정";
    const mode = k ? "내 키로 사용" : pw ? "공용 키(비밀번호)로 사용" : "키 없음";
    flash(`저장됐어요 · ${who} · ${mode}`);
  };

  return (
    <>
      <div className={`backdrop${open ? " open" : ""}`} onClick={closeAccount} aria-hidden />
      <div
        ref={panelRef}
        className={`panel${open ? " open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        inert={!open}
        onKeyDown={onKeyDown}
      >
        <div className="panel-head">
          <h2 id="account-title">계정 설정</h2>
          <button className="x" onClick={closeAccount} aria-label="닫기">
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="field">
            <span>사용자 이름 (작성자)</span>
            <input
              id="mm-author"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="예: Claire"
              autoComplete="off"
              enterKeyHint="done"
            />
          </label>
          <div className="field keyfield mt">
            <span>
              내 Groq API 키 (무료) ·{" "}
              <a href={GROQ_KEYS_URL} target="_blank" rel="noopener noreferrer">
                발급받기 ↗
              </a>
            </span>
            <div className="keyrow">
              <input
                id="groq-key"
                type={showKey ? "text" : "password"}
                aria-label="내 Groq API 키"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="gsk_로 시작하는 키 붙여넣고 Enter"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="done"
              />
              <button type="button" className="btn sm" onClick={() => setShowKey((v) => !v)}>
                {showKey ? "숨기기" : "보기"}
              </button>
            </div>
            {keyBad && <small className="warnline">키 형식이 맞지 않아요. gsk_로 시작하는 전체 키를 붙여넣어 주세요.</small>}
            <small className="muted">키는 이 브라우저에만 저장돼요. 내 키를 넣으면 비밀번호 없이 내 무료 한도로 사용해요.</small>
          </div>
          <label className="field mt">
            <span>접속 비밀번호 (키가 없을 때)</span>
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="사이트 관리자에게 받은 비밀번호"
              autoComplete="current-password"
              enterKeyHint="done"
            />
          </label>
          <label className="field mt">
            <span>인식 언어</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="ko">한국어</option>
              <option value="auto">자동 감지</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="field mt">
            <span>회사·팀 배경 (선택)</span>
            <textarea
              className="memo"
              rows={3}
              maxLength={300}
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              placeholder="예: AI 인프라 회사의 연구소. 모듈 단위로 일하며 모듈장이 이끎"
            />
            <small className="muted memocount">
              AI가 녹취를 이해하는 참고 자료로만 보내요. · {background.length}/300
            </small>
          </label>
          <div className="actions">
            {open && dirty && <span className="muted unsaved">저장 안 된 변경사항 · Enter로 저장</span>}
            <button type="button" className="btn ghost" onClick={closeAccount}>
              닫기
            </button>
            <button type="submit" className="btn primary" disabled={keyBad}>
              저장
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
