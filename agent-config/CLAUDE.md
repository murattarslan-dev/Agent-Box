# Ajan çalışma notları (kullanıcı seviyesi CLAUDE.md)

Bu dosya container içindeki ajanın kalıcı notudur; repo'nun kendi CLAUDE.md'si varsa **o önceliklidir**, bu dosya onu tamamlar.

## Skill haritası

| Faz | Skill | Çıktı |
|---|---|---|
| Analiz | `analyze-architecture` | `.agent/ANALYSIS.md` |
| Plan + onay | `plan-and-approve` | `.agent/PLAN.md` + AskUserQuestion(header "Onay") |
| Geliştirme | `implement` | commit'ler (`agent/<slug>` dalı) |
| Review | `review` | `.agent/REVIEW.md` |
| PR | `open-pr` | AskUserQuestion(header "PR") → push + PR |
| Ortam | `bootstrap-env` | `$SDK_HOME/env.sh`, `.agent/ENV.md` |

Skill'i `Skill` aracıyla çağır (ör. `Skill: analyze-architecture`); içindeki adımları sırayla uygula.

## Yeni oturuma başlarken

1. `git status` ve `git branch --show-current` — nerede olduğunu gör.
2. `.agent/` altında önceki notlar varsa oku (özellikle `PLAN.md`, `REVIEW.md`).
3. Sistem promptundaki "Kapı durumu" satırına bak: plan onayı yoksa 1. fazdan başla; varsa kaldığın yerden devam et.

## Telegram'a uygun yazım

- Başlık için `**kalın**`, madde için `-`, kod için ``` ``` ```; tablo kullanma (Telegram tablo çizemez).
- Dosya yollarını repo köküne göre yaz (`lib/features/x/y.dart`).
- Bir mesaj ≤ ~2500 karakter; uzunsa böl.
