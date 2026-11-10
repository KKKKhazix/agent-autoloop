// `rules explain` and `emit --dry-run`: what this machine's rules file says, without asking a hub or writing a fact.
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { cronOf, eventRule, typeMatches, type Rule, type Rules } from "../kernel/rules.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent } from "../protocol/validate.ts";
import { localeTag, t } from "../host/i18n.ts";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const clock = (zone: string) =>
  ({ timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) as const;
const when = (rule: Rule, rules: Rules, now: number) =>
  eventRule(rule)
    ? t('来源 {"source"} · {"types"}', { source: rule.when.source, types: rule.when.types.join(t("、")) })
    : t('定时 {"cron"}（下次 {"when"}）', {
        cron: describeCron(cronOf(rule)),
        when: new Date(nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!).toLocaleString(
          localeTag(),
          clock(rules.timezone),
        ),
      });

function details(rule: Rule, rules: Rules, now: number) {
  const parts = [when(rule, rules, now), `→ ${rule.to}`, rule.cwd];
  if (rule.parallel) parts.push(t('并发 {"n"}', { n: rule.parallel }));
  if (rule.maxActive) parts.push(t('本规则最多同时 {"n"} 轮', { n: rule.maxActive }));
  if (rule.channels?.length) parts.push(t('只发 {"channels"}', { channels: rule.channels.join(t("、")) }));
  if (rule.resume) parts.push(t("接着上一轮的会话"));
  if (rule.group !== rule.name) parts.push(t('组 {"group"}', { group: rule.group }));
  if (rule.tell !== "needed") parts.push(t('通知 {"when"}', { when: rule.tell }));
  if (rule.skill) parts.push(t("有 Skill"));
  if (rule.prompt) parts.push(t("有 Prompt"));
  if (rule.emits)
    parts.push(t('可发 {"source"} {"types"}', { source: rule.emits.source, types: rule.emits.types.join(t("、")) }));
  return parts.join(" · ");
}

/** The rules as this machine would run them, one line per thing an owner asks about. */
export function explainRules(text: string, now = Date.now(), zone = localZone()): string[] {
  const rules = parseRules(text, now, zone);
  const lines = [
    t('时区 {"zone"}；先问你：{"askFirst"}；{"n"} 条规则', {
      zone: rules.timezone,
      askFirst: rules.askFirst.join(t("、")),
      n: rules.rules.length,
    }),
    t('来源：{"sources"}', {
      sources: Object.entries(rules.sources)
        .map(([id, source]) => t('{"id"}（{"name"}）', { id, name: source.name }))
        .join(t("、")),
    }),
    t('Agent：{"agents"}', {
      agents: Object.entries(rules.agents)
        .map(([id, agent]) => {
          const limit = agent.maxActive ? t('，最多同时 {"n"} 轮', { n: agent.maxActive }) : "";
          return t('{"id"}（{"name"}，{"worker"}，权限 {"access"}{"limit"}）', {
            id,
            name: agent.name,
            worker: agent.worker,
            access: agent.access,
            limit,
          });
        })
        .join(t("、")),
    }),
  ];
  if (Object.keys(rules.channels).length)
    lines.push(
      t('通道：{"channels"}', {
        channels: Object.entries(rules.channels)
          .map(([id, channel]) => {
            const answerers = channel.answerers?.length
              ? t('，回答人 {"who"}', { who: channel.answerers.join(t("、")) })
              : "";
            return t('{"id"}（{"name"}{"answerers"}{"links"}）', {
              id,
              name: channel.name,
              answerers,
              links: channel.links ? t("，带链接") : "",
            });
          })
          .join(t("、")),
      }),
    );
  if (rules.defaultChannels)
    lines.push(t('没写 channels 的卡片和通知默认只发 {"channels"}', { channels: rules.defaultChannels.join(t("、")) }));
  lines.push(t("规则："));
  for (const rule of rules.rules)
    lines.push(t('  {"name"}：{"details"}', { name: rule.name, details: details(rule, rules, now) }));
  for (const task of rules.elsewhere) {
    const answers = task.cwd
      ? t('；问你的，回答后交给 {"agent"} 在 {"cwd"} 接着做', { agent: rules.agents[task.to].name, cwd: task.cwd })
      : "";
    lines.push(
      t('  {"name"}：在别处（{"where"}）{"cron"}{"answers"}', {
        name: task.name,
        where: task.where,
        cron: describeCron(task.cron),
        answers,
      }),
    );
  }
  return lines;
}

/** What a source event would be handed to, by the rules file alone: no hub, no log, no key. */
export function previewEvent(
  text: string,
  source: string,
  event: unknown,
  now = Date.now(),
  zone = localZone(),
): string[] {
  const rules = parseRules(text, now, zone);
  const parsed = parseEvent(event);
  const lines = [
    t('事件：{"source"} {"type"}{"subject"}', {
      source,
      type: parsed.type,
      subject: parsed.subject ? t(' {"subject"}', { subject: parsed.subject }) : "",
    }),
  ];
  if (!rules.sources[source]) lines.push(t('来源 {"source"} 没有登记在 rules.json 的 sources 里', { source }));
  const matched = rules.rules.filter(
    (rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, parsed.type),
  );
  if (!matched.length) {
    lines.push(t("没有规则接这条事件；真发出去会记成「没有规则接的事件」。"));
    return lines;
  }
  lines.push(t("会派给："));
  for (const rule of matched)
    lines.push(t('  {"name"} → {"to"} · {"cwd"}', { name: rule.name, to: rule.to, cwd: rule.cwd }));
  return lines;
}
