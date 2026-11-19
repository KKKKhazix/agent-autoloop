// GitHub webhooks, checked against the repository's secret and turned into events: `issues.opened`,
// `pull_request.labeled`, `issue_comment.created` and so on, the object's number as the subject. In rules.json:
//   "sources": { "github": { "name": "GitHub", "adapter": "github" } }, and AGENT_AUTOLOOP_SECRET_GITHUB in secrets.env.
import { createHmac, timingSafeEqual } from "node:crypto";
import { fit } from "../../worker/contract.ts";

type Input = { headers: Record<string, string | string[] | undefined>; body: string; secret: string };

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

// Push, status and CI events carry no issue or PR object; the head/branch/PR list is the only
// trustworthy identity an event has, so it goes into detail as a clue for later reconciliation.
function headFields(kind: string, payload: RecordValue) {
  if (kind === "push") return { sha: payload.after, branch: String(payload.ref ?? "").replace(/^refs\/heads\//, "") };
  if (kind === "status")
    return { sha: payload.sha, branch: record(Array.isArray(payload.branches) ? payload.branches[0] : null).name };
  if (!["check_run", "check_suite", "workflow_run"].includes(kind)) return {};
  const ci = record(payload[kind]);
  return { sha: ci.head_sha, branch: ci.head_branch, prs: ci.pull_requests };
}

function prClue(value: unknown) {
  if (!Array.isArray(value)) return "";
  const numbers = value
    .map((entry) => record(entry).number)
    .filter((number) => Number.isSafeInteger(number) && Number(number) > 0);
  const csv = [...new Set(numbers)].join(",");
  return csv && csv.length <= 3000 ? `prs=${csv}` : "";
}

function headClue(kind: string, payload: RecordValue) {
  const { sha, branch, prs } = headFields(kind, payload);
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha) || /^0+$/.test(sha)) return "";
  const branchClue =
    typeof branch === "string" && branch ? `branch=${branch.replace(/[^A-Za-z0-9._/-]/g, "-").slice(0, 200)}` : "";
  return [`head=${sha}`, branchClue, prClue(prs)].filter(Boolean).join(" ");
}

export default function github({ headers, body, secret }: Input) {
  const sign = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const given = String(headers["x-hub-signature-256"] ?? "");
  const signed = secret && given.length === sign.length && timingSafeEqual(Buffer.from(given), Buffer.from(sign));
  if (!signed) throw new Error("signature");
  const kind = String(headers["x-github-event"] ?? "");
  if (kind === "ping") return [];
  const payload = JSON.parse(body);
  const object = payload.pull_request ?? payload.issue ?? payload.discussion ?? payload.release ?? null;
  const type = (payload.action ? `${kind}.${payload.action}` : kind).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const repo = String(payload.repository?.full_name ?? "");
  const number = object?.number ? `#${object.number}` : "";
  return [
    {
      id: String(headers["x-github-delivery"] ?? ""),
      type,
      subject: `${repo}${number}`.replace(/[^A-Za-z0-9#._:/@-]/g, "-").slice(0, 100),
      summary: fit(String(payload.comment?.body ?? object?.title ?? payload.head_commit?.message ?? ""), 200),
      detail: fit(
        [headClue(kind, payload), String(payload.comment?.body ?? object?.body ?? "")].filter(Boolean).join("\n"),
        4000,
      ),
      link: encodeURI(
        String(payload.comment?.html_url ?? object?.html_url ?? payload.repository?.html_url ?? ""),
      ).slice(0, 500),
    },
  ];
}
