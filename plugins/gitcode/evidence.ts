export type Text = (value: unknown, limit: number) => { text: string; truncated: boolean };
export type Evidence = { facet: string; coverage: string; reason?: string };

export function pack<T>(items: T[], limit: number, maxParts: number) {
  const chunks: T[][] = [[]];
  let saved = 0;
  let size = 2;
  for (const item of items) {
    const cost = JSON.stringify(item).length + 1;
    if (cost + 2 > limit) continue;
    if (size + cost > limit) {
      if (chunks.length === maxParts) break;
      chunks.push([]);
      size = 2;
    }
    chunks[chunks.length - 1].push(item);
    size += cost;
    saved += 1;
  }
  return { chunks, omitted: items.length - saved };
}

export function evidenceParts<T, Key extends string>(
  data: Evidence & Record<string, unknown>,
  key: Key,
  items: T[],
  maxParts: number,
) {
  const { chunks, omitted } = pack(items, 3000, maxParts);
  const coverage = omitted > 0 ? "partial" : data.coverage;
  const reason = data.reason || (omitted > 0 ? "receipt_limit" : undefined);
  return chunks.map((part, index) => ({
    ...data,
    coverage,
    reason,
    returned: items.length - omitted,
    omitted,
    part: index + 1,
    parts: chunks.length,
    ...({ [key]: part } as Record<Key, T[]>),
  }));
}
