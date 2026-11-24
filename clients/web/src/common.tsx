import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Run } from "./types";

const startup = /^#connect=([a-f0-9]{64})$/.exec(location.hash);
if (startup) {
  sessionStorage.setItem("autoloop-session", startup[1]);
  history.replaceState(null, "", location.pathname);
}
export const session = sessionStorage.getItem("autoloop-session") ?? "";

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Autoloop-Session": session, ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败");
  return value;
}
export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const stamp = (s?: string | null) =>
  s
    ? new Date(s).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "—";
export const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export function useAction() {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function act(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(msg(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { error, busy, act };
}
export function ErrorBox({ text }: { text?: string }) {
  return text ? (
    <div className="error" role="alert">
      {text}
    </div>
  ) : null;
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
export function Box({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="box">
      <div className="boxhead">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Tag({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={"tag " + tone}>{children}</span>;
}
export function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{title}</span>
      {children}
    </label>
  );
}
export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modalhead">
        <h2>{title}</h2>
        <button aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      <div className="modalbody">{children}</div>
    </dialog>
  );
}
export function LinkOut({ href, children }: { href?: string; children: ReactNode }) {
  if (!href || !/^(https?:\/\/|codex:\/\/threads\/|claude:\/\/resume\?)/i.test(href)) return null;
  return (
    <a target="_blank" rel="noreferrer" href={href}>
      {children}
    </a>
  );
}
export function status(run: Run) {
  if (run.stopping && ["queued", "claimed"].includes(run.state)) return ["停止中", "amber"];
  if (run.state === "queued" && run.attempts > 0) return ["等待重派", "amber"];
  return (
    (
      {
        queued: ["排队中", "amber"],
        claimed: ["运行中", "blue"],
        done: ["已完成", "green"],
        nothing: ["无事可做", ""],
        cancelled: ["已停止", ""],
        unknown: ["结果不确定", "red"],
      } as Record<string, string[]>
    )[run.state] ?? [run.state, ""]
  );
}
export function Runs({ runs, open }: { runs: Run[]; open: (r: Run) => void }) {
  return runs.length ? (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>轮次 / 规则</th>
            <th>Agent</th>
            <th>状态</th>
            <th>时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.rule}</strong>
                <small>
                  #{r.id} {r.events[0]?.subject}
                </small>
              </td>
              <td>{r.agent}</td>
              <td>
                <Tag tone={status(r)[1]}>{status(r)[0]}</Tag>
              </td>
              <td className="mono">{stamp(r.finishedAt || r.createdAt)}</td>
              <td>
                <button className="link" onClick={() => open(r)}>
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>暂无执行轮次</Empty>
  );
}
