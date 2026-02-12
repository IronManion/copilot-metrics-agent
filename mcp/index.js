import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ──────────────────────────────────────────────────────────

// Load .env from parent dir or current dir
for (const envDir of [path.join(__dirname, '..'), __dirname]) {
  const envPath = path.join(envDir, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
    break;
  }
}

const ENTERPRISE = process.env.COPILOT_ENTERPRISE || 'github';
const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const API_BASE = 'https://api.github.com';

// ─── Data Loading ───────────────────────────────────────────────────────────

let records = [];

async function fetchMetricsForDay(day) {
  const url = `${API_BASE}/enterprises/${ENTERPRISE}/copilot/metrics/reports/enterprise-1-day?day=${day}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    if (res.status === 404) return [];
    return [];
  }
  const data = await res.json();
  const allRecords = [];
  const links = data.download_links || data.download_urls || [];
  if (links.length > 0) {
    for (const link of links) {
      const dlUrl = typeof link === 'string' ? link : link.url;
      const dlRes = await fetch(dlUrl);
      if (!dlRes.ok) continue;
      const text = await dlRes.text();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { allRecords.push(JSON.parse(trimmed)); } catch(e) {}
      }
    }
  } else if (Array.isArray(data)) {
    allRecords.push(...data);
  }
  return allRecords;
}

async function loadAllData() {
  if (!GITHUB_TOKEN) {
    throw new Error('No GitHub token. Set GH_TOKEN or GITHUB_TOKEN env var with manage_billing:copilot or read:enterprise scope.');
  }
  const today = new Date();
  const days = [];
  for (let i = 1; i <= 28; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  let allRecords = [];
  for (let i = 0; i < days.length; i += 7) {
    const batch = days.slice(i, i + 7);
    const results = await Promise.all(batch.map(day => fetchMetricsForDay(day)));
    for (const recs of results) allRecords = allRecords.concat(recs);
  }
  const seen = new Map();
  for (const rec of allRecords) {
    const key = `${rec.enterprise_id || 'default'}|${rec.day}`;
    seen.set(key, rec);
  }
  records = Array.from(seen.values());
}

// ─── Aggregation Helpers ────────────────────────────────────────────────────

const FEATURE_DISPLAY = {
  chat_panel_agent_mode: 'Agent Mode',
  chat_panel_ask_mode: 'Ask Mode',
  chat_panel_edit_mode: 'Edit Mode',
  chat_panel_custom_mode: 'Custom Mode',
  chat_inline: 'Inline Chat',
  code_completion: 'Code Completion',
  agent_edit: 'Agent Edit',
  chat_panel_unknown_mode: 'Unknown Mode',
};
const AGENT_FEATURES = ['agent_edit', 'chat_panel_agent_mode', 'chat_panel_custom_mode', 'chat_panel_edit_mode'];
const USER_INITIATED_FEATURES = ['code_completion', 'chat_panel_ask_mode', 'chat_inline'];
const CHAT_MODES = ['chat_panel_agent_mode', 'chat_panel_ask_mode', 'chat_panel_edit_mode', 'chat_panel_custom_mode', 'chat_inline'];

function fmt(n) { return n.toLocaleString('en-US'); }

function getDateRange() {
  let start = null, end = null;
  for (const r of records) {
    if (!start || r.day < start) start = r.day;
    if (!end || r.day > end) end = r.day;
  }
  return { start, end };
}

function sumField(field) {
  return records.reduce((s, r) => s + (r[field] || 0), 0);
}

function getSortedDays() {
  return [...new Set(records.map(r => r.day))].sort();
}

function getSummary() {
  const period = getDateRange();
  const maxDau = records.reduce((m, r) => Math.max(m, r.daily_active_users || 0), 0);
  const avgDau = records.length > 0 ? Math.round(records.reduce((s, r) => s + (r.daily_active_users || 0), 0) / records.length) : 0;
  return {
    period,
    peakDailyActiveUsers: maxDau,
    avgDailyActiveUsers: avgDau,
    totalInteractions: sumField('user_initiated_interaction_count'),
    totalCodeGenerated: sumField('code_generation_activity_count'),
    totalCodeAccepted: sumField('code_acceptance_activity_count'),
    totalLocAdded: sumField('loc_added_sum'),
    totalLocDeleted: sumField('loc_deleted_sum'),
    totalDays: records.length,
  };
}

function getDailyTrends() {
  return getSortedDays().map(day => {
    const rec = records.find(r => r.day === day);
    return {
      day,
      dailyActiveUsers: rec?.daily_active_users || 0,
      interactions: rec?.user_initiated_interaction_count || 0,
      codeGenerated: rec?.code_generation_activity_count || 0,
      locAdded: rec?.loc_added_sum || 0,
      locDeleted: rec?.loc_deleted_sum || 0,
    };
  });
}

function getFeatureUsage() {
  const features = {};
  for (const r of records) {
    for (const f of r.totals_by_feature || []) {
      if (!features[f.feature]) features[f.feature] = { interactions: 0, codeGenerated: 0, codeAccepted: 0, locAdded: 0 };
      features[f.feature].interactions += f.user_initiated_interaction_count || 0;
      features[f.feature].codeGenerated += f.code_generation_activity_count || 0;
      features[f.feature].codeAccepted += f.code_acceptance_activity_count || 0;
      features[f.feature].locAdded += f.loc_added_sum || 0;
    }
  }
  return Object.entries(features)
    .map(([feature, d]) => ({ feature, displayName: FEATURE_DISPLAY[feature] || feature, ...d }))
    .sort((a, b) => b.codeGenerated - a.codeGenerated);
}

function getLanguageUsage() {
  const langs = {};
  for (const r of records) {
    for (const l of r.totals_by_language_feature || []) {
      if (!langs[l.language]) langs[l.language] = { codeGenerated: 0, codeAccepted: 0, locAdded: 0 };
      langs[l.language].codeGenerated += l.code_generation_activity_count || 0;
      langs[l.language].codeAccepted += l.code_acceptance_activity_count || 0;
      langs[l.language].locAdded += l.loc_added_sum || 0;
    }
  }
  return Object.entries(langs)
    .map(([language, d]) => ({ language, ...d }))
    .sort((a, b) => b.codeGenerated - a.codeGenerated)
    .slice(0, 20);
}

function getModelUsage() {
  const models = {};
  for (const r of records) {
    for (const m of r.totals_by_model_feature || []) {
      if (!models[m.model]) models[m.model] = { interactions: 0, codeGenerated: 0 };
      models[m.model].interactions += m.user_initiated_interaction_count || 0;
      models[m.model].codeGenerated += m.code_generation_activity_count || 0;
    }
  }
  return Object.entries(models)
    .map(([model, d]) => ({ model, ...d }))
    .sort((a, b) => b.interactions - a.interactions)
    .slice(0, 15);
}

function getIDEUsage() {
  const ides = {};
  for (const r of records) {
    for (const i of r.totals_by_ide || []) {
      if (!ides[i.ide]) ides[i.ide] = { interactions: 0, codeGenerated: 0, locAdded: 0 };
      ides[i.ide].interactions += i.user_initiated_interaction_count || 0;
      ides[i.ide].codeGenerated += i.code_generation_activity_count || 0;
      ides[i.ide].locAdded += i.loc_added_sum || 0;
    }
  }
  return Object.entries(ides)
    .map(([ide, d]) => ({ ide, ...d }))
    .sort((a, b) => b.interactions - a.interactions);
}

function getChatModeStats() {
  const modes = {};
  for (const r of records) {
    for (const f of r.totals_by_feature || []) {
      if (CHAT_MODES.includes(f.feature)) {
        const name = FEATURE_DISPLAY[f.feature];
        if (!modes[name]) modes[name] = { interactions: 0, codeGenerated: 0 };
        modes[name].interactions += f.user_initiated_interaction_count || 0;
        modes[name].codeGenerated += f.code_generation_activity_count || 0;
      }
    }
  }
  return Object.entries(modes)
    .map(([mode, d]) => ({ mode, ...d }))
    .sort((a, b) => b.interactions - a.interactions);
}

function getCodeGenerationStats() {
  let userSuggested = 0, userAdded = 0, agentAdded = 0, agentDeleted = 0;
  for (const r of records) {
    for (const f of r.totals_by_feature || []) {
      if (USER_INITIATED_FEATURES.includes(f.feature)) {
        userSuggested += f.loc_suggested_to_add_sum || 0;
        userAdded += f.loc_added_sum || 0;
      }
      if (AGENT_FEATURES.includes(f.feature)) {
        agentAdded += f.loc_added_sum || 0;
        agentDeleted += f.loc_deleted_sum || 0;
      }
    }
  }
  const completions = { shown: 0, accepted: 0 };
  for (const r of records) {
    for (const f of r.totals_by_feature || []) {
      if (f.feature === 'code_completion') {
        completions.shown += f.code_generation_activity_count || 0;
        completions.accepted += f.code_acceptance_activity_count || 0;
      }
    }
  }
  return {
    userInitiated: { suggested: userSuggested, added: userAdded },
    agentInitiated: { added: agentAdded, deleted: agentDeleted },
    codeCompletions: completions,
    acceptanceRate: completions.shown > 0 ? Math.round((completions.accepted / completions.shown) * 10000) / 100 : 0,
  };
}

function getPullRequestStats() {
  let totalReviewed = 0, totalCreated = 0, copilotCreated = 0, copilotReviewed = 0;
  for (const r of records) {
    if (r.pull_requests) {
      totalReviewed += r.pull_requests.total_reviewed || 0;
      totalCreated += r.pull_requests.total_created || 0;
      copilotCreated += r.pull_requests.total_created_by_copilot || 0;
      copilotReviewed += r.pull_requests.total_reviewed_by_copilot || 0;
    }
  }
  return { totalReviewed, totalCreated, copilotCreated, copilotReviewed };
}

// ─── Lazy data loading ──────────────────────────────────────────────────────

let dataLoaded = false;
let dataLoading = null;

async function ensureData() {
  if (dataLoaded) return;
  if (dataLoading) return dataLoading;
  dataLoading = loadAllData().then(() => { dataLoaded = true; });
  return dataLoading;
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'copilot-metrics',
  version: '1.0.0',
});

server.tool(
  'get_summary',
  'Get a high-level summary of Copilot usage metrics for the enterprise including peak/avg daily active users, total interactions, code generated, LOC added/deleted over a 28-day period',
  {},
  async () => {
    await ensureData();
    return { content: [{ type: 'text', text: JSON.stringify(getSummary(), null, 2) }] };
  }
);

server.tool(
  'get_daily_trends',
  'Get daily trend data showing daily active users, interactions, code generated, and LOC added/deleted for each day in the 28-day period',
  {},
  async () => { await ensureData(); return { content: [{ type: 'text', text: JSON.stringify(getDailyTrends(), null, 2) }] }; }
);

server.tool(
  'get_feature_usage',
  'Get usage breakdown by Copilot feature (Agent Mode, Ask Mode, Edit Mode, Code Completion, Agent Edit, Inline Chat, etc.) showing interactions, code generated, code accepted, LOC added per feature',
  {},
  async () => { await ensureData(); return { content: [{ type: 'text', text: JSON.stringify(getFeatureUsage(), null, 2) }] }; }
);

server.tool(
  'get_language_usage',
  'Get top 20 programming languages by code generation activity, showing code generated, code accepted, and LOC added per language',
  {},
  async () => { await ensureData(); return { content: [{ type: 'text', text: JSON.stringify(getLanguageUsage(), null, 2) }] }; }
);

server.tool(
  'get_model_usage',
  'Get AI model usage data showing interactions and code generated per model (e.g., claude-sonnet-4, gpt-4.1, etc.)',
  {},
  async () => { await ensureData(); return { content: [{ type: 'text', text: JSON.stringify(getModelUsage(), null, 2) }] }; }
);

server.tool(
  'get_ide_usage',
  'Get IDE distribution showing interactions, code generated, and LOC added per IDE (vscode, intellij, neovim, visualstudio, etc.)',
  {},
  async () => { await ensureData(); return { content: [{ type: 'text', text: JSON.stringify(getIDEUsage(), null, 2) }] }; }
);

server.tool(
  'get_chat_mode_stats',
  'Get breakdown of chat interactions by mode (Agent Mode, Ask Mode, Edit Mode, Custom Mode, Inline Chat) showing interactions and code generated per mode',
  {},
  async () => { await ensureData(); return { content: [{ type: 'text', text: JSON.stringify(getChatModeStats(), null, 2) }] }; }
);

server.tool(
  'get_code_generation_stats',
  'Get code generation statistics including user-initiated vs agent-initiated code changes, code completion acceptance rate, and LOC suggested vs actually added',
  {},
  async () => { await ensureData(); return { content: [{ type: 'text', text: JSON.stringify(getCodeGenerationStats(), null, 2) }] }; }
);

server.tool(
  'get_pull_request_stats',
  'Get pull request statistics including total PRs created, reviewed, and how many were created/reviewed by Copilot',
  {},
  async () => { await ensureData(); return { content: [{ type: 'text', text: JSON.stringify(getPullRequestStats(), null, 2) }] }; }
);

server.tool(
  'refresh_data',
  'Re-fetch the latest 28 days of Copilot metrics data from the GitHub API',
  {},
  async () => {
    dataLoaded = false;
    dataLoading = null;
    await loadAllData();
    dataLoaded = true;
    return { content: [{ type: 'text', text: `Refreshed. Loaded ${records.length} days of data.` }] };
  }
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  // Connect transport immediately so the CLI can initialize
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Data is loaded lazily on first tool call via ensureData()
}

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
