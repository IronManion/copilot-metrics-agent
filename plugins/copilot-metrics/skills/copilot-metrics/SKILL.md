---
name: copilot-metrics
description: Query GitHub Copilot usage metrics for your enterprise. USE THIS SKILL for ANY question about Copilot adoption, usage, trends, code generation, feature adoption, language/model/IDE breakdown, or pull request statistics. This includes questions about how many people use Copilot, which features are most popular, what languages generate the most code, agent vs user-initiated code changes, code completion acceptance rates, and daily/weekly active user trends. Trigger phrases include "Copilot usage", "how many active users", "agent adoption", "code generation stats", "which model is most used", "top languages", "IDE breakdown", "feature adoption", "acceptance rate", "pull request stats", "Copilot trends", etc.
---

# Copilot Metrics

Query GitHub Copilot usage metrics for your enterprise directly from the GitHub API. Data covers a rolling 28-day window of enterprise-level Copilot IDE usage.

## CRITICAL: When to Use This Skill

**USE Copilot Metrics for ANY question about GitHub Copilot usage or adoption.**

**ALWAYS use Copilot Metrics when the user asks about:**

| User Question Pattern | Example | Action |
|-----------------------|---------|--------|
| Overall usage summary | "How is Copilot being used?" | `get_summary` |
| Active users / adoption | "How many people use Copilot?" | `get_summary` or `get_daily_trends` |
| Daily/weekly trends | "Show me the usage trend" | `get_daily_trends` |
| Feature adoption | "Which features are most popular?" | `get_feature_usage` |
| Agent mode usage | "How much is agent mode used?" | `get_feature_usage` or `get_chat_mode_stats` |
| Code generation stats | "What's the acceptance rate?" | `get_code_generation_stats` |
| Language breakdown | "Top languages for code gen?" | `get_language_usage` |
| Model usage | "Which AI model is most used?" | `get_model_usage` |
| IDE distribution | "What IDEs are people using?" | `get_ide_usage` |
| Chat mode breakdown | "Agent Mode vs Ask Mode?" | `get_chat_mode_stats` |
| Pull request stats | "How many PRs does Copilot create?" | `get_pull_request_stats` |
| Refresh data | "Get the latest data" | `refresh_data` |

## Configuration

The MCP server reads authentication from environment variables:
- `GH_TOKEN` or `GITHUB_TOKEN` — GitHub PAT with `manage_billing:copilot` or `read:enterprise` scope
- `COPILOT_ENTERPRISE` — Enterprise slug (default: `github`)

These can also be set in a `.env` file in the project root.

## MCP Tools

### get_summary
High-level enterprise summary: peak/avg daily active users, total interactions, code generated, LOC added/deleted.

| Tool | Parameters |
|------|------------|
| `get_summary` | `{}` |

### get_daily_trends
Daily breakdown with active users, interactions, code generated, LOC for each of the 28 days.

| Tool | Parameters |
|------|------------|
| `get_daily_trends` | `{}` |

### get_feature_usage
Usage per Copilot feature (Code Completion, Agent Mode, Ask Mode, Edit Mode, Agent Edit, Inline Chat, etc.).

| Tool | Parameters |
|------|------------|
| `get_feature_usage` | `{}` |

### get_language_usage
Top 20 programming languages by code generation activity.

| Tool | Parameters |
|------|------------|
| `get_language_usage` | `{}` |

### get_model_usage
AI model usage (interactions + code generated per model).

| Tool | Parameters |
|------|------------|
| `get_model_usage` | `{}` |

### get_ide_usage
IDE distribution (interactions, code generated, LOC per IDE).

| Tool | Parameters |
|------|------------|
| `get_ide_usage` | `{}` |

### get_chat_mode_stats
Chat interaction breakdown by mode (Agent Mode, Ask Mode, Edit Mode, Custom Mode, Inline Chat).

| Tool | Parameters |
|------|------------|
| `get_chat_mode_stats` | `{}` |

### get_code_generation_stats
Code generation stats: user vs agent code changes, completion acceptance rate, LOC suggested vs added.

| Tool | Parameters |
|------|------------|
| `get_code_generation_stats` | `{}` |

### get_pull_request_stats
Pull request statistics: total created/reviewed, Copilot-created/reviewed PRs.

| Tool | Parameters |
|------|------------|
| `get_pull_request_stats` | `{}` |

### refresh_data
Re-fetch the latest 28 days of data from the GitHub API.

| Tool | Parameters |
|------|------------|
| `refresh_data` | `{}` |

## Common Use Cases

### Executive Summary
| Tool | Parameters |
|------|------------|
| `get_summary` | `{}` |

### Adoption Analysis
Call `get_summary` for peak/avg DAU, then `get_daily_trends` for the growth curve, then `get_feature_usage` for which features drive adoption.

### Agent Mode Impact
Call `get_feature_usage` and `get_code_generation_stats` to compare agent-initiated vs user-initiated code changes and understand agent adoption.

### Language & Model Insights
Call `get_language_usage` and `get_model_usage` to understand which languages and models generate the most code.
