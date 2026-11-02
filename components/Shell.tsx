"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AccountPanel from "./AccountPanel";
import Composer from "./Composer";
import { openAccount, useHydrated, useStore } from "@/lib/store";

const TABS = [
  { href: "/", label: "회의록 작성" },
  { href: "/glossary", label: "용어 사전" },
  { href: "/history", label: "지난 회의록" },
];

/**
 * 공통 틀: 헤더 + 작성 화면 + 각 페이지.
 * 작성 화면은 다른 탭에서도 숨겨만 둠 — 언마운트되면 진행 중인 녹음·받아쓰기가 끊기기 때문.
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const loaded = useHydrated();
  const account = useStore((s) => s.account);
  const toast = useStore((s) => s.toast);
  const recording = useStore((s) => s.activity.recording);
  const working = useStore((s) => s.activity.working);

  return (
    <>
      <header className="apphead">
        <div className="apphead-in">
          <Link href="/" className="brand">
            <span className="logo" aria-hidden />
            <span>회의록 메이커</span>
          </Link>
          <nav className="navtabs" aria-label="화면">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} aria-current={path === t.href ? "page" : undefined}>
                {t.label}
                {t.href === "/" && (recording || working) && path !== "/" && (
                  <span
                    className={`navdot${recording ? " rec" : ""}`}
                    role="img"
                    aria-label={recording ? "녹음 중" : "작업 중"}
                    title={recording ? "녹음 중" : "작업 중"}
                  />
                )}
              </Link>
            ))}
          </nav>
          <div className="chipslot">
            {loaded && (
              <button className="userchip" onClick={() => openAccount()} title="계정 설정 열기">
                <span className="avatar" aria-hidden>
                  {account.author ? account.author.trim().charAt(0).toUpperCase() : "?"}
                </span>
                <span className="who">{account.author ? `${account.author}님` : "사용자 설정"}</span>
                <span className={`tag${account.groqKey ? " mine" : account.pw ? "" : " none"}`}>
                  {account.groqKey ? "내 키" : account.pw ? "공용" : "키 없음"}
                </span>
              </button>
            )}
          </div>
        </div>
      </header>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      <main className="wrap">
        <div hidden={path !== "/"}>
          <Composer />
        </div>
        {children}
        <footer className="foot">
          음성은 Groq 서버(Whisper large-v3)로 전송되어 텍스트로 변환되고, 회의록은 오픈소스 LLM(gpt-oss)이 작성합니다.
          발언자 구분은 녹취 내용(호칭·이름)으로 추정하므로 반드시 검토하세요. 사내 기밀 회의는 회사 보안 정책을 먼저 확인하세요.
        </footer>
      </main>

      <AccountPanel />
    </>
  );
}
