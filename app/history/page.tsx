"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HistoryItem, deleteHistory, flash, getActivity, requestOpen, useHydrated, useStore } from "@/lib/store";

export default function HistoryPage() {
  const loaded = useHydrated();
  const history = useStore((s) => s.history);
  const router = useRouter();
  const [q, setQ] = useState("");

  const open = (h: HistoryItem) => {
    const a = getActivity();
    if (a.recording || a.working) {
      flash("녹음·받아쓰기·회의록 작성이 끝난 뒤에 열 수 있어요.");
      return;
    }
    if (a.dirty && !confirm("작성 중인 내용이 사라집니다. 이 회의록을 불러올까요?")) return;
    requestOpen(h);
    router.push("/");
  };
  const remove = (h: HistoryItem) => {
    if (confirm(`"${h.title}" 회의록을 삭제할까요?`)) deleteHistory(h.id);
  };

  const needle = q.trim().toLowerCase();
  const shown = needle ? history.filter((h) => h.title.toLowerCase().includes(needle)) : history;

  if (!loaded) return null;

  return (
    <>
      <div className="pagehead">
        <h1>지난 회의록</h1>
        <span className="muted">{history.length}개</span>
      </div>
      <p className="muted pagehint">이 브라우저에만 저장됩니다. 최근 30개까지 보관해요.</p>

      {!history.length ? (
        <section className="card empty">
          <strong>아직 만든 회의록이 없어요</strong>
          <p className="muted">회의록을 만들면 여기에 자동으로 저장돼요.</p>
          <Link className="btn" href="/">
            회의록 작성하기
          </Link>
        </section>
      ) : (
        <section className="card history">
          <input
            className="searchbox"
            type="search"
            aria-label="제목 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="제목 검색"
            autoComplete="off"
          />
          {shown.length === 0 ? (
            <p className="muted emptyline">“{q.trim()}”에 해당하는 회의록이 없어요.</p>
          ) : (
            <ul>
              {shown.map((h) => (
                <li key={h.id}>
                  <button className="link" onClick={() => open(h)} title="작성 화면에 불러오기">
                    <strong>{h.title}</strong>
                    <span className="muted">{h.date}</span>
                  </button>
                  <button className="btn ghost sm" onClick={() => open(h)}>
                    열기
                  </button>
                  <button className="btn ghost sm" aria-label={`${h.title} 삭제`} onClick={() => remove(h)}>
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
