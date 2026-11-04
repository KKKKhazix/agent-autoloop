// GitLab webhooks, checked against the project's secret token and turned into events:
// `merge_request.opened`, `issue.created`, `push`, `issue_comment.created` and so on.
// In rules.json:
//   "sources": { "gitlab": { "name": "GitLab", "adapter": "gitlab" } }, and AGENT_AUTOLOOP_SECRET_GITLAB in secrets.env.
import { timingSafeEqual } from "node:crypto";

type Input = { headers: Record<string, string | string[] | undefined>; body: string; secret: string };

export default function gitlab({ headers, body, secret }: Input) {
  const given = String(headers["x-gitlab-token"] ?? "");
  const signed = secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!signed) throw new Error("signature");
  const kind = String(headers["x-gitlab-event"] ?? "");
  if (kind === "ping") return [];
  const payload = JSON.parse(body);
  const object_kind = String(payload.object_kind ?? kind);
  // The action lives on object_attributes, not on the top-level payload.
  const action = String(payload.object_attributes?.action ?? payload.action ?? "");
  const type = (action ? `${object_kind}.${action}` : object_kind).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const project = payload.project ?? payload.repository ?? {};
  const repo = String(project.full_name ?? project.path_with_namespace ?? project.name ?? "");
  const object_attributes = payload.object_attributes ?? payload.merge_request ?? payload.issue ?? {};
  const iid = object_attributes.iid ?? object_attributes.id ?? "";
  // Use the Idempotency-Key header so retries keep the same id and are not dispatched twice.
  const idempotencyKey = String(headers["idempotency-key"] ?? "");
  const id = idempotencyKey || String(object_attributes.id ?? payload.object_id ?? crypto.randomUUID());
  const subject = `${repo}#${iid}`.replace(/[^A-Za-z0-9#._:/@-]/g, "-").slice(0, 100);
  return [
    {
      id,
      type,
      subject,
      summary: String(object_attributes.title ?? payload.commits?.[0]?.message ?? "").slice(0, 200),
      detail: String(object_attributes.description ?? object_attributes.message ?? "").slice(0, 4000),
      link: encodeURI(String(object_attributes.url ?? project.web_url ?? "")).slice(0, 500),
    },
  ];
}
