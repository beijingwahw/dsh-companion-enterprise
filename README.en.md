# DeepSeek Companion Enterprise

> The enterprise companion plugin for DeepSeek Harness — an AI engineering-efficiency and security platform for enterprise development teams.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-orange)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.md)

**DeepSeek Companion Enterprise** is an enterprise-grade companion plugin built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), providing development teams with a complete capability matrix spanning **security & compliance** through **collaboration efficiency**. All data stays inside the local Harness sandbox — zero telemetry, zero tracking.

---

## Core Capabilities

### Security & Compliance
- **Security audit**: full operation audit logs with export and search
- **DLP data-loss prevention**: a built-in rule engine auto-detects sensitive information such as API keys, phone numbers, emails, and passwords, with custom rules and toggles
- **Key management**: named key vaults, scope control, rotation reminders, leak detection

### Team Collaboration & Knowledge Management
- **Team configuration**: member preferences, default policies, config import/export with diffing
- **Knowledge snapshots**: session snapshot archiving and retrieval
- **Experience library**: team knowledge capture, notes, smart recommendations
- **Review flow**: multi-round reviews, comments, decisions, merging

### Task Orchestration & Automation
- **Task orchestrator**: multi-step pipeline definitions, conditional branches, timeout/retry, dependency management
- **Scheduled jobs**: Cron scheduling, off-peak execution, resume from breakpoints
- **Task queues**: running / queued / done / failed state tracking

### Developer Efficiency
- **Multi-model arena**: parallel model comparison with historical evaluation records
- **Execution trace analysis**: latency/token/anomaly detection, slowest-step location
- **Prompt engineering workbench**: version management, template library, variable interpolation
- **API cost governance**: live pricing (dynamic scraping of official pricing pages), budget control, usage reports

### Foundations
- **Smart conversation export**: Markdown / PDF / JSON, single-session and batch ZIP
- **Context handoff summary**: auto-generated session handoff summaries armed for the next conversation
- **Global conversation search**: full-text search + tag management

---

## Installation

### Prerequisites
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `>= 0.1.0`
- Node.js `^22.19 || >=24`
- pnpm (`npm install -g pnpm`)

### One-line install

```bash
dsh plugin add beijingwahw/dsh-companion-enterprise --profile web
```

The plugin panel loads automatically once started:

```bash
dsh web
```

> Handy commands: upgrade `dsh plugin upgrade dsh-companion-enterprise --profile web`; uninstall `dsh plugin remove dsh-companion-enterprise --profile web`; install from a local path `dsh plugin add ./dsh-companion-enterprise --profile web`.

---

## Module List

| Module | Description | Default |
|------|------|:--------:|
| `security` | Security audit and DLP data-loss prevention | ✅ |
| `team` | Team collaboration and knowledge management | ✅ |
| `orchestrator` | Task orchestration and resume from breakpoints | ✅ |
| `arena` | Multi-model arena | ✅ |
| `trace` | Execution trace analysis | ✅ |
| `prompt` | Prompt engineering workbench | ✅ |
| `cost` | API cost governance | ✅ |
| `export` | Smart conversation export | ✅ |
| `handoff` | Context handoff summary | ✅ |
| `search` | Global conversation search | ✅ |

Every module can be toggled independently in `cordis.patch.yml`.

---

## Permissions & Privacy

- **Network**: accesses only `api.deepseek.com` (model calls) and five official pricing pages (read-only GET, used for dynamic pricing)
- **Storage**: uses only the `companion` storage domain; data stays inside the local Harness plugin sandbox
- **Privacy**: no behavioral tracking, no telemetry, no data reporting; conversation content and API keys stay local

---

## Development

```bash
pnpm install          # install dependencies
pnpm run build        # compile TypeScript
pnpm run typecheck    # type check
pnpm run dev          # local HMR development
```

### Build and install from source (contributors / offline)

```bash
git clone https://github.com/beijingwahw/dsh-companion-enterprise.git
cd dsh-companion-enterprise
pnpm install
pnpm run build
dsh plugin add . --profile web
```

### Project Structure

```
src/
├── core/            # Core services (storage adapter, HTTP, crypto, privacy, pricing)
├── modules/         # Feature modules
│   ├── security/    # Security audit and DLP
│   ├── team/        # Team collaboration and knowledge management
│   ├── orchestrator/# Task orchestration
│   ├── arena/       # Multi-model arena
│   ├── trace/       # Execution trace analysis
│   ├── prompt/      # Prompt engineering workbench
│   ├── cost/        # API cost governance
│   ├── export/      # Smart conversation export
│   ├── handoff/     # Context handoff summary
│   └── search/      # Global conversation search
├── client/          # Web UI components
└── types/           # Type declarations
```

---

## Contributing

Issues and pull requests are welcome. Please follow these conventions:

1. Fork this repository and create a feature branch
2. Make sure `npm run typecheck` passes
3. Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification for commit messages
4. Open a PR describing the changes

---

## License

[MIT](LICENSE)

---

## Related Links

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — Everything is a Plugin
- [dsh-plugin Topic](https://github.com/topics/dsh-plugin) — the DeepSeek Harness plugin ecosystem
- [DeepSeek Companion](https://github.com/beijingwahw/dsh-companion) — Lite edition
- [DeepSeek Companion Dev](https://github.com/beijingwahw/dsh-companion-dev) — Developer edition
