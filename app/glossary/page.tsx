"use client";

import { useState } from "react";
import TagInput from "@/components/TagInput";
import { GlossaryEntry, normalizeGlossary, parseGlossary } from "@/lib/glossary";
import { flash, saveGlossary, useHydrated, useStore } from "@/lib/store";

const EXAMPLES: GlossaryEntry[] = [
  { term: "모듈장", variants: ["모듈짱", "모들장"], desc: "모듈을 책임지는 리더" },
  { term: "모듈원", variants: ["모디건", "모드원"], desc: "모듈에 속한 구성원" },
  { term: "트러블", variants: ["트러그", "튜러블"], desc: "문제·장애 상황" },
  { term: "R&R", variants: ["알앤알", "알엔알"], desc: "Role & Responsibility, 역할과 책임" },
  { term: "아크릴 넥스트", variants: ["아크네스", "아크릴넥"], desc: "제품·서비스 이름 예시 (실제 설명으로 바꿔 주세요)" },
];

const keyOf = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const BLANK = { term: "", variants: [] as string[], desc: "" };

export default function GlossaryPage() {
  const loaded = useHydrated();
  const glossary = useStore((s) => s.glossary);
  const [draft, setDraft] = useState(BLANK);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // 수정 중인 항목의 용어
  const [edit, setEdit] = useState(BLANK);

  const add = () => {
    if (!draft.term.trim()) {
      document.getElementById("new-term")?.focus();
      return;
    }
    const merged = glossary.some((e) => keyOf(e.term) === keyOf(draft.term));
    saveGlossary(normalizeGlossary([...glossary, draft]));
    flash(merged ? `이미 있는 "${draft.term.trim()}" 항목에 합쳤어요.` : `"${draft.term.trim()}"을(를) 추가했어요.`);
    setDraft(BLANK);
    document.getElementById("new-term")?.focus();
  };
  const startEdit = (e: GlossaryEntry) => {
    setEditing(e.term);
    setEdit({ term: e.term, variants: e.variants, desc: e.desc });
  };
  const saveEdit = () => {
    if (!edit.term.trim()) return;
    // 다른 항목과 같은 이름으로 바꾸면 normalizeGlossary가 합침
    saveGlossary(normalizeGlossary(glossary.map((e) => (e.term === editing ? edit : e))));
    setEditing(null);
    flash("수정했어요.");
  };
  const remove = (e: GlossaryEntry) => {
    if (!confirm(`"${e.term}"을(를) 사전에서 삭제할까요?`)) return;
    saveGlossary(glossary.filter((x) => x !== e));
    if (editing === e.term) setEditing(null);
  };
  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(glossary, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "용어사전.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  /** 지금 사전에 합침 (같은 용어는 형태를 합치고, 설명은 파일 값 우선) */
  const importJson = async (f: File | undefined) => {
    if (!f) return;
    try {
      const g = parseGlossary(await f.text());
      saveGlossary(normalizeGlossary([...glossary, ...g]));
      flash(`${g.length}개 항목을 가져왔어요.`);
    } catch (e) {
      flash(`가져오지 못했어요: ${(e as Error).message}`);
    }
  };

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? glossary.filter((e) => [e.term, e.desc, ...e.variants].some((s) => s.toLowerCase().includes(needle)))
    : glossary;

  if (!loaded) return null;

  return (
    <>
      <div className="pagehead">
        <h1>용어 사전</h1>
        <span className="muted">{glossary.length}개</span>
        <span className="headbtns">
          <label className="btn ghost sm">
            가져오기
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                importJson(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <button className="btn ghost sm" disabled={!glossary.length} onClick={exportJson}>
            내보내기
          </button>
        </span>
      </div>
      <p className="muted pagehint">
        자주 틀리는 형태는 받아쓰기 직후 용어로 자동으로 바뀌어요. 회의록·교정 때는 구간과 관련된 항목만 AI에 함께 보내요.
      </p>

      <section className="card">
        <h2 className="cardtitle">새 용어</h2>
        <form
          className="termform"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label className="field">
            <span>용어</span>
            <input
              id="new-term"
              value={draft.term}
              onChange={(e) => setDraft({ ...draft, term: e.target.value })}
              placeholder="예: 아크릴 넥스트"
              autoComplete="off"
            />
          </label>
          <div className="field">
            <label htmlFor="new-variants">자주 틀리는 형태 (Enter로 추가)</label>
            <TagInput id="new-variants" value={draft.variants} onChange={(variants) => setDraft({ ...draft, variants })} placeholder="예: 아크네스" />
          </div>
          <label className="field termform-wide">
            <span>설명</span>
            <input
              value={draft.desc}
              onChange={(e) => setDraft({ ...draft, desc: e.target.value })}
              placeholder="한두 줄로 (선택)"
              autoComplete="off"
            />
          </label>
          <div className="termform-btn">
            <button type="submit" className="btn primary">
              추가
            </button>
          </div>
        </form>
      </section>

      {!glossary.length ? (
        <section className="card empty">
          <strong>아직 등록한 용어가 없어요</strong>
          <p className="muted">회사·제품·사람 이름이나 자주 잘못 받아써지는 말을 넣으면 받아쓰기와 교정이 정확해져요.</p>
          <button
            className="btn"
            onClick={() => {
              saveGlossary(EXAMPLES);
              flash("예시를 넣었어요. 우리 회사에 맞게 고쳐서 쓰세요.");
            }}
          >
            예시로 시작하기
          </button>
        </section>
      ) : (
        <section className="card">
          <input
            className="searchbox"
            type="search"
            aria-label="용어 사전 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="용어·형태·설명 검색"
            autoComplete="off"
          />
          {needle && (
            <p className="muted small">
              검색 결과 {shown.length} / {glossary.length}
            </p>
          )}
          {shown.length === 0 ? (
            <p className="muted emptyline">“{q.trim()}”에 해당하는 용어가 없어요.</p>
          ) : (
            <table className="termtable">
              <thead>
                <tr>
                  <th scope="col">용어</th>
                  <th scope="col">자주 틀리는 형태</th>
                  <th scope="col">설명</th>
                  <th scope="col">
                    <span className="sr">관리</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) =>
                  editing === e.term ? (
                    <tr key={e.term} className="editing">
                      <td colSpan={4}>
                        <form
                          className="termform"
                          onSubmit={(ev) => {
                            ev.preventDefault();
                            saveEdit();
                          }}
                        >
                          <label className="field">
                            <span>용어</span>
                            <input value={edit.term} onChange={(ev) => setEdit({ ...edit, term: ev.target.value })} autoComplete="off" autoFocus />
                          </label>
                          <div className="field">
                            <label htmlFor="edit-variants">자주 틀리는 형태 (Enter로 추가)</label>
                            <TagInput id="edit-variants" value={edit.variants} onChange={(variants) => setEdit({ ...edit, variants })} />
                          </div>
                          <label className="field termform-wide">
                            <span>설명</span>
                            <input value={edit.desc} onChange={(ev) => setEdit({ ...edit, desc: ev.target.value })} autoComplete="off" />
                          </label>
                          <div className="termform-btn">
                            <button type="button" className="btn ghost sm" onClick={() => setEditing(null)}>
                              취소
                            </button>
                            <button type="submit" className="btn primary sm" disabled={!edit.term.trim()}>
                              저장
                            </button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  ) : (
                    <tr key={e.term}>
                      <td className="t-term">{e.term}</td>
                      <td className="t-vars" data-label="자주 틀리는 형태" data-empty={e.variants.length ? undefined : ""}>
                        {e.variants.length ? (
                          e.variants.map((v) => (
                            <span className="chip plain" key={v}>
                              {v}
                            </span>
                          ))
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                      <td className="t-desc" data-label="설명" data-empty={e.desc ? undefined : ""}>
                        {e.desc || <span className="muted">–</span>}
                      </td>
                      <td className="t-act">
                        <button className="btn ghost sm" aria-label={`${e.term} 수정`} onClick={() => startEdit(e)}>
                          수정
                        </button>
                        <button className="btn ghost sm" aria-label={`${e.term} 삭제`} onClick={() => remove(e)}>
                          삭제
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </section>
      )}
    </>
  );
}
