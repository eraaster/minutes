/**
 * 화면끼리 공유하는 상태 (계정·용어 사전·지난 회의록·토스트). localStorage 키는 예전 그대로.
 * 모듈 변수 + useSyncExternalStore: 서버 렌더·첫 hydrate는 빈 값, 그다음 저장값으로 바뀜.
 */
import { useSyncExternalStore } from "react";
import { GlossaryEntry, migrateTerms, parseGlossary } from "./glossary";

export type HistoryItem = { id: string; title: string; date: string; minutes: string; transcript: string; createdAt: number; memo?: string };
export type Account = { author: string; groqKey: string; pw: string; lang: string; background: string };
/** 작성 화면 상황: 다른 화면에서 안내·확인할 때 씀 */
export type Activity = { recording: boolean; working: boolean; dirty: boolean };

type State = {
  account: Account;
  glossary: GlossaryEntry[];
  history: HistoryItem[];
  accountOpen: null | "name" | "key"; // 열린 계정 패널이 처음 포커스할 칸
  toast: string;
  openRequest: HistoryItem | null; // 작성 화면에 불러올 지난 회의록
  activity: Activity;
};

export const LS = {
  key: "mm-groq-key",
  pw: "mm-pw",
  lang: "mm-lang",
  hist: "mm-history",
  author: "mm-author",
  type: "mm-type",
  brief: "mm-brief",
  terms: "mm-terms",
  glossary: "mm-glossary",
  background: "mm-background",
};

export function lsGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** 저장된 사전을 읽음. 없으면 예전 쉼표 사전(mm-terms)에서 옮겨 옴 */
function loadGlossary(): GlossaryEntry[] {
  const saved = lsGet(LS.glossary);
  if (saved === null) {
    const g = migrateTerms(lsGet(LS.terms) || "");
    lsSet(LS.glossary, JSON.stringify(g));
    return g;
  }
  try {
    return parseGlossary(saved);
  } catch {
    return [];
  }
}
function loadHistory(): HistoryItem[] {
  try {
    const h = JSON.parse(lsGet(LS.hist) || "[]");
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

const EMPTY: State = {
  account: { author: "", groqKey: "", pw: "", lang: "ko", background: "" },
  glossary: [],
  history: [],
  accountOpen: null,
  toast: "",
  openRequest: null,
  activity: { recording: false, working: false, dirty: false },
};

let state: State | null = null;
const listeners = new Set<() => void>();

function current(): State {
  if (!state)
    state = {
      ...EMPTY,
      account: {
        author: lsGet(LS.author) || "",
        groqKey: lsGet(LS.key) || "",
        pw: lsGet(LS.pw) || "",
        lang: lsGet(LS.lang) || "ko",
        background: lsGet(LS.background) || "",
      },
      glossary: loadGlossary(),
      history: loadHistory(),
    };
  return state;
}
function update(p: Partial<State>) {
  state = { ...current(), ...p };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 고른 값이 바뀔 때만 다시 그림 (selector는 상태의 필드를 그대로 돌려줄 것) */
export function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => pick(current()),
    () => pick(EMPTY)
  );
}
const noSub = () => () => {};
/** 저장값을 읽을 수 있게 된 뒤로 true (저장값에 따라 달라지는 화면의 깜빡임 방지) */
export const useHydrated = () =>
  useSyncExternalStore(
    noSub,
    () => true,
    () => false
  );

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function flash(msg: string) {
  clearTimeout(toastTimer);
  update({ toast: msg });
  toastTimer = setTimeout(() => update({ toast: "" }), 2600);
}

export function saveAccount(a: Account) {
  lsSet(LS.author, a.author);
  lsSet(LS.key, a.groqKey);
  lsSet(LS.pw, a.pw);
  lsSet(LS.lang, a.lang);
  lsSet(LS.background, a.background);
  update({ account: a });
}
export const openAccount = (focus: "name" | "key" = "name") => update({ accountOpen: focus });
export const closeAccount = () => update({ accountOpen: null });

export function saveGlossary(g: GlossaryEntry[]) {
  lsSet(LS.glossary, JSON.stringify(g));
  update({ glossary: g });
}

function saveHistory(h: HistoryItem[]) {
  lsSet(LS.hist, JSON.stringify(h));
  update({ history: h });
}
export const addHistory = (item: HistoryItem) => saveHistory([item, ...current().history].slice(0, 30));
export const deleteHistory = (id: string) => saveHistory(current().history.filter((h) => h.id !== id));

export const requestOpen = (item: HistoryItem | null) => update({ openRequest: item });
export const getActivity = () => current().activity;
export function setActivity(a: Activity) {
  const c = current().activity;
  if (c.recording !== a.recording || c.working !== a.working || c.dirty !== a.dirty) update({ activity: a });
}
