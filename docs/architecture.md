# Mimari

## Bileşenler

```
┌─────────────────────────────── container (agent uid 1000) ───────────────────────────────┐
│                                                                                           │
│  src/bot.ts ── grammY ──▶ Telegram Bot API (long polling)                                 │
│     │  komutlar, yetki, kuyruk, inline-buton soru/izin akışı, ilerleme mesajı             │
│     ▼                                                                                     │
│  src/agent.ts ── @anthropic-ai/claude-agent-sdk ── query()                                │
│     │  systemPrompt = claude_code preset + agent-config/SYSTEM_PROMPT.md + dinamik durum  │
│     │  settingSources = [user, project]  → ~/.claude (bizim CLAUDE.md + skills) + repo     │
│     │  canUseTool  → AskUserQuestion'ı Telegram butonuna çevirir                           │
│     │  hooks       → PreToolUse: src/gate.ts (faz kapısı) · PostToolUse: PR URL yakalama   │
│     ▼                                                                                     │
│  Claude Code (SDK ile gömülü binary) ──▶ /data/repo   (Bash, Read, Edit, Task, Skill…)    │
│                                          BASH_ENV=/data/sdks/env.sh → SDK'lar PATH'te     │
└───────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ volume'lar: /data (repo, ~/.claude, state.json, cache'ler)  ·  /sdks/<isim>/<sürüm> (paylaşımlı)
```

## Faz makinesi ve kapı

`src/state.ts` → `/data/state.json`: `phase`, `approved`, `prApproved`, `freeMode`, `sessionId`, `branch`, `task`, `costUsd`.

`src/gate.ts` her araç çağrısından önce (PreToolUse hook) karar verir:

| Araç | Koşul | Sonuç |
|------|-------|-------|
| `Write/Edit/MultiEdit/NotebookEdit` repo içine (`.agent/` hariç) | `approved == false` | reddet: "KAPI KAPALI… plan-and-approve" |
| `Bash: git commit` | `approved == false` | reddet |
| `Bash: git push` / `gh pr create` / `glab mr create` | `prApproved == false` | reddet: "…review + PR onayı" |
| `Bash: git push origin <default>` / force-push / `rm -rf /` benzeri | her zaman | reddet |

Bayraklar yalnızca kullanıcı cevabıyla değişir: `AskUserQuestion` header'ı `Onay` → `✅` cevabı `approved=true`;
header `PR` → `✅` cevabı `prApproved=true`. PR açılınca (PostToolUse'ta URL yakalanır) ikisi de sıfırlanır.
`/approve`, `/free`, `AUTO_PR` bunları elle/otomatik açar.

Model bir reddi gördüğünde system prompt ona "bu hata değil, sıra hatırlatması" der; eksik fazı uygular.

## Skill'ler

`agent-config/skills/<ad>/SKILL.md`, container açılışında `~/.claude/skills/`'e kopyalanır; Claude Code bunları
`Skill` aracıyla çağırır. Her biri fazın kontrat metnidir:

- **analyze-architecture** — kanıtlı mimari tespiti, etkilenecek dosyalar, örnek alınacak kalıp → `.agent/ANALYSIS.md`
- **plan-and-approve** — kısa plan (`.agent/PLAN.md`) + zorunlu `AskUserQuestion(header:"Onay")`
- **implement** — `agent/<slug>` dalı, küçük conventional commit'ler, testler, kapsam disiplini
- **review** — bağımsız `Task` alt-ajanı, önem etiketli bulgular, ≤3 tur, `.agent/REVIEW.md`
- **open-pr** — PR metni, `AskUserQuestion(header:"PR")`, `gh pr create` / `glab mr create`
- **bootstrap-env** — `sdk-env --list` vs `sdk-detect`, eksikleri `sdk-install` ile container'a özel kur

Repo'nun kendi `CLAUDE.md` ve `.claude/skills`'i de yüklenir ve **önceliklidir** (system prompt bunu söyler).

## SDK volume mekanizması

```
up.sh
 ├─ sdk-volumes.sh detect      one-shot container: sdk-detect-remote.sh (repo bağlıysa onu, değilse sığ klon) → "isim sürüm"
 ├─ sdk-volumes.sh ensure      volume var + .installed == sürüm → atla
 │                             /data/sdks/<isim>/<sürüm>/.installed varsa → volume'a kopyala (terfi)
 │                             yoksa: docker volume create + docker run --user root sdk-install.sh (root → chown → agent)
 ├─ sdk-volumes.sh compose     docker-compose.override.yml (external volume mount'ları)
 └─ docker compose up
container
 └─ entrypoint → sdk-env.sh    /sdks/*/* ve /data/sdks/*/* → tek env.sh (fragmanlar $SDK_DIR ile yeniden konumlanabilir)
```

Her SDK dizini: `<kök>/<isim>/<sürüm>/{.installed, .meta, env.sh, <içerik>}`. Cache'ler (`pub-cache`, `gopath`,
`npm-global`) paylaşımlı volume'u kirletmemek için `/data/sdks` altındadır.

Kubernetes'te aynı akış PVC + Job ile: `sdk-volumes.sh k8s-ensure` PVC'yi oluşturur, Job'ı bekler, PVC'yi
`claude-agent/installed=<sürüm>` ile annotate eder; `k8s-mounts` Deployment'a mount fragmanlarını üretir.

## Git kimliği ve kimlik bilgileri

`docker/entrypoint.sh`: `user.name/email` global; token `~/.git-token` (0600); `~/bin/git-credential-agent` yalnızca
`get` işlemine ve yalnızca `REPO_HOST` için cevap verir (`store` helper'ın aksine geçici bir 401'de token'ı silmez).
`gh` için `GH_TOKEN`, `glab` için `GITLAB_TOKEN`/`GITLAB_HOST` env'den. Remote URL temizdir (`https://host/owner/repo.git`).

## Telegram katmanı ayrıntıları

- Markdown → Telegram HTML dönüşümü (`src/telegram-io.ts`), 4096 limitine göre `<pre>` bloklarını bölerek parçalama, HTML reddedilirse düz metne düşme.
- İlerleme: tek mesaj, ≤14 satır, 1.5 sn throttle ile `editMessageText`.
- Sorular: `canUseTool("AskUserQuestion")` → inline keyboard; tekli/çoklu seçim, "kendi cevabım" → sonraki metin cevap sayılır; `/cancel` bekleyen soruyu reddeder ve turu keser.
- Alt-ajan (Task) mesajları ana akışa dökülmez (`parent_tool_use_id` doluysa atlanır).
- Açılışta Claude token'ı `GET /v1/models` ile hafifçe doğrulanır; 401 ise Telegram'a 🔴 bildirim (Claude Code'un 11 denemelik sessiz retry'ına takılmamak için).
