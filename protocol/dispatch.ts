// Owner-only scheduling controls, never accepted as source event fields.
import { InputError } from "../kernel/errors.ts";
export type Dispatch = {
  id: string;
  rule: string;
  lane: string;
  eventIds: number[];
  resumeFrom?: number;
  context?: Record<string, unknown>;
};
export function parseDispatch(value: any): Dispatch {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !["id", "rule", "lane", "eventIds", "resumeFrom", "context"].includes(k))
  )
    throw new InputError("派发字段不正确");
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.id))
    throw new InputError("派发 id 不正确");
  if (typeof value.rule !== "string" || !value.rule.trim() || value.rule.length > 200)
    throw new InputError("派发 rule 不正确");
  if (typeof value.lane !== "string" || !/^[A-Za-z0-9#._:\/@-]{1,100}$/.test(value.lane))
    throw new InputError("派发 lane 不正确");
  if (
    !Array.isArray(value.eventIds) ||
    !value.eventIds.length ||
    value.eventIds.length > 100 ||
    value.eventIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) < 1) ||
    new Set(value.eventIds).size !== value.eventIds.length
  )
    throw new InputError("事件编号必须唯一，最多100个");
  if (value.resumeFrom !== undefined && (!Number.isSafeInteger(value.resumeFrom) || value.resumeFrom < 1))
    throw new InputError("续接轮次不正确");
  if (
    value.context !== undefined &&
    (!value.context ||
      typeof value.context !== "object" ||
      Array.isArray(value.context) ||
      JSON.stringify(value.context).length > 8000)
  )
    throw new InputError("派发 context 要是8000字以内的对象");
  return {
    id: value.id,
    rule: value.rule,
    lane: value.lane,
    eventIds: [...value.eventIds],
    ...(value.resumeFrom !== undefined && { resumeFrom: value.resumeFrom }),
    ...(value.context !== undefined && { context: canonical(value.context) }),
  };
}

// JSON object key order is not part of the idempotency contract.
export function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
