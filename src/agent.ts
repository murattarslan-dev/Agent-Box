/**
 * Claude Agent SDK sarmalayıcısı. Telegram katmanından bağımsızdır; IO arayüzü
 * üzerinden metin/ilerleme/soru akışını dışarı verir.
 */
import fs from "node:fs";
import path from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { loadState, saveState } from "./state.js";
import * as gate from "./gate.js";

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AgentIO {
  text(markdown: string): Promise<void>;
  progress(line: string): void;
  /** Kullanıcıya soru sor; cevap map'i döner (soru metni → cevap). */
  askQuestions(questions: Question[]): Promise<Record<string, string>>;
  /** allowedTools dışında bir araç için izin iste. */
  askPermission(toolName: string, input: Record<string, unknown>): Promise<boolean>;
  status(line: string): Promise<void>;
}

export interface RunResult {
  ok: boolean;
  summary: string;
  costUsd: number;
  turns: number;
  durationMs: number;
}

const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "Skill",
  "ToolSearch",
];

/** /sdks ve $SDK_HOME altındaki kurulu SDK'ları "isim sürüm" olarak listeler (sistem promptu için). */
function listSdks(): string {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const root of ["/sdks", config.sdkHome]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      let vers: string[] = [];
      try {
        vers = fs.readdirSync(path.join(root, name));
      } catch {
        continue;
      }
      for (const ver of vers) {
        if (seen.has(name)) continue;
        if (fs.existsSync(path.join(root, name, ver, ".installed"))) {
          seen.add(name);
          found.push(`${name} ${ver}${root === "/sdks" ? "" : " (özel)"}`);
        }
      }
    }
  }
  return found.length ? found.join(", ") : "yok (gerekiyorsa bootstrap-env)";
}

function readSystemPromptAppend(): string {
  const p = path.join(config.agentConfigDir, "SYSTEM_PROMPT.md");
  let base = "";
  try {
    base = fs.readFileSync(p, "utf8");
  } catch {
    base = "";
  }
  const st = loadState();
  const dyn = [
    "",
    "## Çalışma ortamı (dinamik)",
    `- Repo dizini: ${config.repoDir}`,
    `- Repo: ${config.repoPath || config.repoUrl} (${config.provider}, host: ${config.repoHost || "?"})`,
    `- Varsayılan dal: ${config.defaultBranch}`,
    `- SDK dizini: ${config.sdkHome} (BASH_ENV=${config.sdkHome}/env.sh her bash'te yüklenir)`,
    `- Bağlı SDK'lar: ${listSdks()}`,
    `- Git kimliğin: ${config.gitUserName} <${config.gitUserEmail}>`,
    `- PR aracı: ${config.provider === "github" ? "gh pr create" : "glab mr create"}`,
    `- Kapı durumu: faz=${st.phase}, planOnayı=${st.approved ? "VAR" : "YOK"}, prOnayı=${st.prApproved ? "VAR" : "YOK"}${st.freeMode ? ", SERBEST MOD" : ""}${config.autoPr ? ", AUTO_PR açık (PR sorusu atlanır)" : ""}`,
    st.branch ? `- Aktif görev dalı: ${st.branch}` : "",
    st.task ? `- Aktif görev: ${st.task}` : "",
    `- Tarih: ${new Date().toISOString().slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return base + "\n" + dyn + "\n";
}

export class Agent {
  private abort?: AbortController;
  private _busy = false;
  private q?: ReturnType<typeof query>;

  get busy() {
    return this._busy;
  }

  async interrupt() {
    try {
      await this.q?.interrupt();
    } catch {
      /* yut */
    }
    this.abort?.abort();
  }

  async run(prompt: string, io: AgentIO, opts: { fresh?: boolean } = {}): Promise<RunResult> {
    if (this._busy) throw new Error("Ajan meşgul");
    this._busy = true;
    this.abort = new AbortController();
    const started = Date.now();
    const st = loadState();

    const options: Options = {
      cwd: config.repoDir,
      model: config.model,
      maxTurns: config.maxTurns,
      abortController: this.abort,
      settingSources: ["user", "project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: readSystemPromptAppend() },
      allowedTools: ALLOWED_TOOLS,
      permissionMode: "default",
      includePartialMessages: false,
      resume: opts.fresh ? undefined : st.sessionId,
      env: { ...process.env },
      stderr: (d: string) => {
        if (config.logLevel === "debug") process.stderr.write("[claude] " + d);
      },
      canUseTool: async (toolName, input) => {
        try {
          if (toolName === "AskUserQuestion") {
            const questions = (input.questions ?? []) as Question[];
            const answers = await io.askQuestions(questions);
            for (const q of questions) {
              const a = answers[q.question];
              if (a) gate.applyAnswer(q.header ?? "", a);
            }
            return { behavior: "allow", updatedInput: { ...input, answers } };
          }
          const ok = await io.askPermission(toolName, input);
          return ok
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Kullanıcı bu aracı reddetti." };
        } catch (e: any) {
          // kullanıcı /cancel veya /new dedi: soruyu iptal et ve turu bitir
          return { behavior: "deny", message: `Kullanıcı iptal etti (${e?.message ?? "iptal"}). Dur ve bekle.`, interrupt: true };
        }
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name !== "PreToolUse") return {};
                const d = gate.decide(hookInput.tool_name, (hookInput.tool_input ?? {}) as Record<string, unknown>);
                if (d.allow) return {};
                io.progress(`⛔ ${hookInput.tool_name} engellendi (kapı)`);
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: d.reason,
                  },
                };
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name !== "PostToolUse") return {};
                const cmd = String((hookInput.tool_input as any)?.command ?? "");
                if (!/\b(gh\s+pr\s+create|glab\s+mr\s+create)\b/.test(cmd)) return {};
                const out = JSON.stringify(hookInput.tool_response ?? "");
                const m = out.match(/https?:\/\/[^\s"\\]+\/(?:pull|merge_requests)\/\d+/);
                if (m) {
                  gate.onPrCreated(m[0]);
                  io.progress(`🎉 PR açıldı: ${m[0]}`);
                }
                return {};
              },
            ],
          },
        ],
      },
    };

    let result: RunResult = { ok: false, summary: "", costUsd: 0, turns: 0, durationMs: 0 };
    let lastText = "";

    try {
      this.q = query({ prompt, options });
      for await (const msg of this.q as AsyncIterable<SDKMessage>) {
        await this.handle(msg, io, (t) => (lastText = t));
        if (msg.type === "result") {
          const r = msg as any;
          result = {
            ok: r.subtype === "success" && !r.is_error,
            summary: typeof r.result === "string" ? r.result : r.subtype,
            costUsd: r.total_cost_usd ?? 0,
            turns: r.num_turns ?? 0,
            durationMs: r.duration_ms ?? Date.now() - started,
          };
          if (r.subtype !== "success") {
            result.summary = `Oturum ${r.subtype} ile bitti${r.errors?.length ? ": " + r.errors.join("; ") : ""}`;
            const rejected = Object.entries(loadState().limits ?? {}).find(([, l]) => l.status === "rejected");
            if (rejected) {
              const { fmtTime } = await import("./limits.js");
              result.summary += `\n⛔ Abonelik limiti dolu (${rejected[0]}); sıfırlanma ${fmtTime(rejected[1].resetsAt)}. O saatten sonra "devam et" yaz.`;
            }
          }
          const s = loadState();
          saveState({ costUsd: s.costUsd + result.costUsd, turns: s.turns + result.turns, sessionId: r.session_id ?? s.sessionId });
        }
      }
    } catch (e: any) {
      if (this.abort?.signal.aborted) {
        result = { ok: false, summary: "İptal edildi.", costUsd: 0, turns: 0, durationMs: Date.now() - started };
      } else {
        result = { ok: false, summary: "Hata: " + (e?.message ?? String(e)), costUsd: 0, turns: 0, durationMs: Date.now() - started };
      }
    } finally {
      this._busy = false;
      this.q = undefined;
    }
    if (!result.summary && lastText) result.summary = lastText;
    return result;
  }

  private async handle(msg: SDKMessage, io: AgentIO, setLast: (t: string) => void) {
    switch (msg.type) {
      case "system": {
        const m = msg as any;
        if (m.subtype === "init" && m.session_id) {
          saveState({ sessionId: m.session_id });
          io.progress(`🟢 oturum ${String(m.session_id).slice(0, 8)} · model ${m.model}`);
        }
        break;
      }
      case "assistant": {
        const m = msg as any;
        // alt-ajan mesajlarını ana akışa dökme (parent_tool_use_id doluysa alt-ajandır)
        if (m.parent_tool_use_id) break;
        const blocks = m.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "text" && b.text?.trim()) {
            setLast(b.text);
            await io.text(b.text);
          } else if (b.type === "tool_use") {
            const { toolLine } = await import("./telegram-io.js");
            io.progress(toolLine(b.name, b.input ?? {}));
          }
        }
        break;
      }
      case "rate_limit_event": {
        const info = (msg as any).rate_limit_info ?? {};
        const type: string = info.rateLimitType ?? "unknown";
        let util: number | undefined = typeof info.utilization === "number" ? info.utilization : undefined;
        if (util !== undefined && util <= 1) util = util * 100;
        let resetsAt: number | undefined = typeof info.resetsAt === "number" ? info.resetsAt : undefined;
        if (resetsAt !== undefined && resetsAt < 1e12) resetsAt = resetsAt * 1000;
        const prev = loadState().limits?.[type];
        const next = { status: info.status ?? "allowed", utilization: util, resetsAt, at: new Date().toISOString() };
        saveState({ limits: { ...(loadState().limits ?? {}), [type]: next } });
        const worsened = next.status !== "allowed" && prev?.status !== next.status;
        const crossed = util !== undefined && (prev?.utilization ?? 0) < 80 && util >= 80;
        if (worsened || crossed) {
          const { formatLimits } = await import("./limits.js");
          await io.status(
            (next.status === "rejected" ? "⛔ Abonelik limitine takıldın." : "⚠️ Abonelik limitine yaklaşıyorsun.") +
              "\n" + formatLimits(loadState().limits),
          );
        }
        break;
      }
      case "user": {
        // araç sonuçlarında hata var mı? (kısa bilgi)
        const m = msg as any;
        if (m.parent_tool_use_id) break;
        const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const b of blocks) {
          if (b.type === "tool_result" && b.is_error) {
            const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            io.progress(`⚠️ ${t.replace(/\s+/g, " ").slice(0, 140)}`);
          }
        }
        break;
      }
      default:
        break;
    }
  }
}
