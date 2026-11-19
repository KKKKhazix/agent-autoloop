import { createHash } from "node:crypto";

export const GITHUB_OBSERVATION = "github.collection.observed";
export const GITHUB_EVIDENCE = "github.collection.evidence";

const MAX_PARTS = 99;
const PART_SIZE = 3750;
const statuses = ["complete", "partial", "failed", "rejected"] as const;
type Status = (typeof statuses)[number];
type Report = { version: number; status: Status; batches: readonly unknown[] };
type Event = { id: string; type: string; subject: string; summary: string; detail: string; link: string };

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function githubReceipt(report: Report, run: string): Event[] {
  if (!/^[1-9][0-9]{0,15}$/.test(run) || !Number.isSafeInteger(Number(run))) throw new Error("invalid Hub run");
  const encoded = Buffer.from(JSON.stringify(report)).toString("base64");
  const parts = Math.ceil(encoded.length / PART_SIZE);
  const subject = `github:run:${run}`;
  const event = (type: string, suffix: string, summary: string, detail: string): Event => ({
    id: `${subject}:${suffix}`,
    type,
    subject,
    summary,
    detail,
    link: "",
  });
  const header = (data: object) =>
    event(GITHUB_OBSERVATION, "result", "GitHub 采集结果", JSON.stringify({ version: 1, ...data }));
  if (parts > MAX_PARTS) return [header({ status: "partial", reason: "receipt_capacity", parts: 0 })];
  return [
    header({ status: report.status, parts, sha256: digest(encoded) }),
    ...Array.from({ length: parts }, (_, index) =>
      event(
        GITHUB_EVIDENCE,
        `part:${index}`,
        "GitHub 采集证据",
        encoded.slice(index * PART_SIZE, (index + 1) * PART_SIZE),
      ),
    ),
  ];
}

export function readGitHubReceipt(events: Pick<Event, "id" | "type" | "subject" | "detail">[]) {
  const header = events.find((event) => event.type === GITHUB_OBSERVATION);
  if (!header || !/^github:run:[1-9][0-9]{0,15}$/.test(header.subject) || header.id !== `${header.subject}:result`)
    return null;
  try {
    const { version, status, parts, reason, sha256 } = JSON.parse(header.detail);
    if (version !== 1 || !statuses.includes(status) || !Number.isInteger(parts) || parts < 0 || parts > MAX_PARTS)
      return null;
    if (events.length !== parts + 1) return null;
    if (!parts)
      return status === "partial" && reason === "receipt_capacity"
        ? { status: "partial", reason: "receipt_capacity", report: null }
        : null;
    const pieces = new Map<string, string>();
    for (const event of events) {
      if (event === header) continue;
      if (
        event.type !== GITHUB_EVIDENCE ||
        event.subject !== header.subject ||
        event.detail.length > PART_SIZE ||
        pieces.has(event.id)
      )
        return null;
      pieces.set(event.id, event.detail);
    }
    const ordered = Array.from({ length: parts }, (_, index) => pieces.get(`${header.subject}:part:${index}`));
    if (ordered.some((part) => !part)) return null;
    const encoded = ordered.join("");
    if (digest(encoded) !== sha256) return null;
    const report = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (report.version !== 1 || report.status !== status || !Array.isArray(report.batches)) return null;
    return { status, report };
  } catch {
    return null;
  }
}
