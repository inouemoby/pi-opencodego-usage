import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

const PROVIDER_ID = "opencode-go";
const DISPLAY_NAME = "OpenCode Go";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CACHE_MS = 60_000;
const IDLE_REFRESH_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

interface WindowUsage {
  percent: number;
  resetMs: number;
}

interface OpenCodeGoUsageData {
  fiveHour: WindowUsage | null;
  weekly: WindowUsage | null;
  monthly: WindowUsage | null;
  _ts: number;
}

function humanDuration(untilMs: number): string {
  if (untilMs <= 0) return "now";
  const m = Math.floor(untilMs / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins}m`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

function usageSeverity(pct: number, windowMs: number, resetMs: number): number {
  if (pct < 0 || resetMs <= 0) return 0;
  const remainingMs = resetMs - Date.now();
  const elapsedMs = Math.max(0, windowMs - remainingMs);
  const elapsedRatio = elapsedMs / windowMs;
  const expectedPct = elapsedRatio * 100;

  if (pct > expectedPct * 1.5) return 2;
  if (pct > expectedPct) return 1;
  return 0;
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi", "agent");
}

function readApiKey(): string {
  if (process.env.OPENCODE_API_KEY?.trim()) return process.env.OPENCODE_API_KEY.trim();
  if (process.env.OPENCODE_GO_API_KEY?.trim()) return process.env.OPENCODE_GO_API_KEY.trim();

  try {
    const credential = readStoredCredential(PROVIDER_ID);
    if (credential?.type === "api_key" && credential.key) return credential.key;
  } catch {
    // Fall back to reading auth.json directly.
  }

  try {
    const authPath = path.join(getAgentDir(), "auth.json");
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      const record = auth[PROVIDER_ID];
      if (typeof record === "string") return record;
      if (record?.type === "api_key" && typeof record.key === "string") return record.key;
      if (typeof record?.key === "string") return record.key;
    }
  } catch {
    // Auth unreadable.
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWindow(value: unknown): WindowUsage | null {
  if (!isRecord(value)) return null;
  if (value.status !== "ok") return null;
  if (typeof value.percent !== "number" || !Number.isFinite(value.percent)) return null;
  const resetMs = typeof value.resetsAt === "string" ? Date.parse(value.resetsAt) : NaN;
  return {
    percent: +value.percent.toFixed(1),
    resetMs: Number.isFinite(resetMs) ? resetMs : 0,
  };
}

async function fetchRemoteQuota(apiKey: string): Promise<OpenCodeGoUsageData> {
  const resp = await fetch(USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "pi-opencodego-usage",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenCode Go usage failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  const body: unknown = await resp.json();
  if (!isRecord(body) || !isRecord(body.usage)) {
    throw new Error("OpenCode Go returned an unrecognized usage response");
  }
  return {
    fiveHour: parseWindow(body.usage.rolling),
    weekly: parseWindow(body.usage.weekly),
    monthly: parseWindow(body.usage.monthly),
    _ts: Date.now(),
  };
}

function flagFor(pct: number, windowMs: number, resetMs: number): string {
  const sev = usageSeverity(pct, windowMs, resetMs);
  return sev === 2 ? "!!" : sev === 1 ? "!" : "";
}

export default function piOpenCodeGoUsage(pi: ExtensionAPI): void {
  let usage: OpenCodeGoUsageData | null = null;
  let usagePromise: Promise<OpenCodeGoUsageData> | null = null;
  let footerOn = false;
  let _tui: any = null;
  let latestCtx: any = null;
  let agentBusy = false;
  let thinkingLevel = "off";
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  function isOpenCodeGo(ctx: any): boolean {
    return ctx?.model?.provider === PROVIDER_ID;
  }

  async function getUsage(force = false): Promise<OpenCodeGoUsageData> {
    if (!force && usage && Date.now() - usage._ts < CACHE_MS) {
      return usage;
    }
    if (usagePromise) return usagePromise;
    const apiKey = readApiKey();
    if (!apiKey) throw new Error("No OpenCode API key found");

    usagePromise = fetchRemoteQuota(apiKey)
      .then((data) => {
        usage = data;
        return data;
      })
      .finally(() => {
        usagePromise = null;
      });
    return usagePromise;
  }

  function trigger() {
    setTimeout(() => {
      try {
        _tui?.requestRender?.();
      } catch {
        /* footer unmounted */
      }
    }, 0);
  }

  async function refresh(ctx: any, force = false): Promise<void> {
    if (!isOpenCodeGo(ctx)) {
      if (usage) {
        usage = null;
        toggleFooter(ctx);
      }
      return;
    }
    try {
      await getUsage(force);
      trigger();
    } catch {
      /* silent */
    }
  }

  function toggleFooter(ctx: any): void {
    if (isOpenCodeGo(ctx) && readApiKey()) {
      if (!footerOn) {
        ctx.ui.setFooter(buildFooter(ctx));
        footerOn = true;
      }
    } else {
      if (footerOn) {
        _tui = null;
        ctx.ui.setFooter(undefined as any);
        footerOn = false;
      }
    }
  }

  function buildFooter(ctx: any) {
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => tui.requestRender());

      return {
        dispose: () => {
          unsub();
          _tui = null;
          footerOn = false;
        },
        invalidate() {},
        render(width: number): string[] {
          const sm = ctx.sessionManager;

          // ── Line 1: pwd ──────────────────────────────────
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const sname = sm.getSessionName?.();
          if (sname) pwd += ` • ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: stats ────────────────────────────────
          let ti = 0, to = 0, tr = 0, tw = 0, tc = 0;
          for (const e of sm.getEntries()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = (e.message as AssistantMessage).usage;
              ti += u.input; to += u.output;
              tr += u.cacheRead; tw += u.cacheWrite;
              tc += u.cost?.total || 0;
            }
          }
          const parts: string[] = [];
          const cachePartIndexes: number[] = [];
          let costPartIndex = -1;
          if (ti) parts.push(`↑${formatTokens(ti)}`);
          if (to) parts.push(`↓${formatTokens(to)}`);
          if (tr) { cachePartIndexes.push(parts.length); parts.push(`R${formatTokens(tr)}`); }
          if (tw) { cachePartIndexes.push(parts.length); parts.push(`W${formatTokens(tw)}`); }
          if (tc) { costPartIndex = parts.length; parts.push(`$${tc.toFixed(3)}`); }

          // Context %
          const cu = ctx.getContextUsage();
          const cw = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const raw = cu?.percent;
          const cp = raw !== null && raw !== undefined ? raw.toFixed(1) : "?";
          let cpStr: string;
          if (cp === "?") cpStr = `?/${formatTokens(cw)} (auto)`;
          else if (parseFloat(cp) > 90) cpStr = theme.fg("error", `${cp}%/${formatTokens(cw)} (auto)`);
          else if (parseFloat(cp) > 70) cpStr = theme.fg("warning", `${cp}%/${formatTokens(cw)} (auto)`);
          else cpStr = `${cp}%/${formatTokens(cw)} (auto)`;
          parts.push(cpStr);

          // ── OpenCode Go quota segment ──
          // Compact: `Mo:Z% 5h:X%Wk:Y%` with no separator between
          // the 5h and weekly meters. Progressively omit monthly,
          // then rolling windows when the footer is narrow.
          let usageFull = "";
          let usageCompact = "";
          let usageIdx = -1;
          if (usage) {
            const rolling: string[] = [];
            if (usage.fiveHour) {
              const w = usage.fiveHour;
              rolling.push(`${flagFor(w.percent, FIVE_HOUR_MS, w.resetMs)}5h:${w.percent}%`);
            }
            if (usage.weekly) {
              const w = usage.weekly;
              rolling.push(`${flagFor(w.percent, WEEK_MS, w.resetMs)}Wk:${w.percent}%`);
            }
            const rollingText = rolling.join("");
            const monthlyText = usage.monthly ? `Mo:${usage.monthly.percent}%` : "";
            usageCompact = rollingText;
            usageFull = [monthlyText, rollingText].filter(Boolean).join(" ");
            usageIdx = parts.length;
            parts.push(usageFull);
          }

          let left = parts.join(" ");

          // Right side: model info
          const m = ctx.model;
          let right = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            right = tl === "off" ? `${right} • thinking off` : `${right} • ${tl}`;
          }
          const withProv = `(${PROVIDER_ID}) ${right}`;
          if (visibleWidth(left) + 2 + visibleWidth(withProv) <= width) {
            right = withProv;
          }

          // Match Codex's compacting order: omit cache counters, cost,
          // then the monthly quota before touching the rolling windows.
          if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
            for (const index of cachePartIndexes) parts[index] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (visibleWidth(left) + 2 + visibleWidth(right) > width && costPartIndex >= 0) {
            parts[costPartIndex] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (visibleWidth(left) + 2 + visibleWidth(right) > width && usageIdx >= 0) {
            parts[usageIdx] = usageCompact;
            left = parts.filter(Boolean).join(" ");
          }

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);

          let ln2: string;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }

          return [ln1, theme.fg("dim", ln2)];
        },
      };
    };
  }

  function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setInterval(async () => {
      if (agentBusy) return;
      if (!readApiKey()) return;
      const ctx = latestCtx;
      if (!ctx || !isOpenCodeGo(ctx)) return;
      await refresh(ctx);
    }, IDLE_REFRESH_MS);
    (idleTimer as any).unref?.();
  }

  function stopIdleTimer() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  }

  // ── Events ─────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    latestCtx = ctx;
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    footerOn = false;
    toggleFooter(ctx);
    if (readApiKey()) refresh(ctx);
    startIdleTimer();
  });

  pi.on("session_shutdown", async () => {
    stopIdleTimer();
  });

  pi.on("agent_start", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = true;
    const tl = pi.getThinkingLevel?.() || "off";
    if (tl !== thinkingLevel) {
      thinkingLevel = tl;
      trigger();
    }
  });

  pi.on("agent_end", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = false;
    if (readApiKey()) refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => {
    latestCtx = ctx;
    if (isOpenCodeGo(ctx)) {
      setTimeout(() => {
        toggleFooter(ctx);
        if (readApiKey()) refresh(ctx);
      }, 0);
    } else {
      toggleFooter(ctx);
      if (readApiKey()) refresh(ctx);
    }
  });

  pi.on("thinking_level_select", async (event: any) => {
    thinkingLevel = event?.level || "off";
    trigger();
  });

  // ── /opencodego ────────────────────────────────────────────
  pi.registerCommand("opencodego", {
    description: "Show OpenCode Go subscription usage and limits",
    handler: async (_args, ctx) => {
      try {
        const d = await getUsage(true);
        const lines: string[] = [`══ ${DISPLAY_NAME} Usage ══`];
        if (d.monthly) {
          lines.push(`Monthly:   ${d.monthly.percent}% used (resets in ${humanDuration(d.monthly.resetMs - Date.now())})`);
        }
        if (d.fiveHour) {
          lines.push(`5h window: ${d.fiveHour.percent}% used (resets in ${humanDuration(d.fiveHour.resetMs - Date.now())})`);
        }
        if (d.weekly) {
          lines.push(`Weekly:    ${d.weekly.percent}% used (resets in ${humanDuration(d.weekly.resetMs - Date.now())})`);
        }
        lines.push(`Refreshed: ${new Date(d._ts).toLocaleTimeString()}`);
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: any) {
        ctx.ui.notify(`OpenCode Go usage error: ${err.message}`, "error");
      }
    },
  });
}
