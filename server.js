import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CopilotClient, defineTool } from '@github/copilot-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
const envPath = path.join(__dirname, '.env');
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
}

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory data store ───────────────────────────────────────────────────
let records = [];
let preGeneratedReports = {};

// ─── Data Loading ───────────────────────────────────────────────────────────

const ENTERPRISE = process.env.COPILOT_ENTERPRISE || 'github';
const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const API_BASE = 'https://api.github.com';

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
    console.warn(`API error for ${day}: ${res.status} ${res.statusText}`);
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
    console.error('ERROR: No GitHub token found. Set GH_TOKEN or GITHUB_TOKEN environment variable.');
    console.error('Token needs manage_billing:copilot or read:enterprise scope.');
    process.exit(1);
  }

  console.log(`Fetching metrics for enterprise: ${ENTERPRISE}`);
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
    console.log(`Fetching days: ${batch[0]} to ${batch[batch.length - 1]}...`);
    const results = await Promise.all(batch.map(day => fetchMetricsForDay(day)));
    for (const recs of results) {
      allRecords = allRecords.concat(recs);
    }
  }

  // Deduplicate by enterprise_id + day (or just day for single enterprise)
  const seen = new Map();
  for (const rec of allRecords) {
    const key = `${rec.enterprise_id || 'default'}|${rec.day}`;
    seen.set(key, rec);
  }
  records = Array.from(seen.values());
  console.log(`Total unique records: ${records.length}`);
}

// ─── Aggregation Helpers ────────────────────────────────────────────────────

function getDateRange() {
  let start = null, end = null;
  for (const r of records) {
    if (!start || r.day < start) start = r.day;
    if (!end || r.day > end) end = r.day;
  }
  return { start, end };
}

function getUniqueUsers() {
  // Enterprise data has daily_active_users count, not individual user_login
  // Return a pseudo-set with .size = max daily_active_users across all days
  const maxDau = records.reduce((m, r) => Math.max(m, r.daily_active_users || 0), 0);
  return { size: maxDau };
}

function sumField(field) {
  return records.reduce((s, r) => s + (r[field] || 0), 0);
}

function countUsersWhere(predicate) {
  // Not applicable for enterprise-level data; return aggregate approximation
  let count = 0;
  for (const r of records) {
    if (predicate(r)) count++;
  }
  return count;
}

function aggregateByDay() {
  const days = {};
  for (const r of records) {
    if (!days[r.day]) {
      days[r.day] = { interactions: 0, codeGenerated: 0, locAdded: 0, activeUsers: 0 };
    }
    const d = days[r.day];
    d.interactions += r.user_initiated_interaction_count || 0;
    d.codeGenerated += r.code_generation_activity_count || 0;
    d.locAdded += r.loc_added_sum || 0;
    d.activeUsers = r.daily_active_users || 0;
  }
  return Object.entries(days)
    .map(([day, d]) => ({
      day,
      interactions: d.interactions,
      codeGenerated: d.codeGenerated,
      locAdded: d.locAdded,
      activeUsers: d.activeUsers,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function aggregateByFeature() {
  const features = {};
  for (const r of records) {
    for (const f of r.totals_by_feature || []) {
      if (!features[f.feature]) {
        features[f.feature] = { interactions: 0, codeGenerated: 0, locAdded: 0 };
      }
      features[f.feature].interactions += f.user_initiated_interaction_count || 0;
      features[f.feature].codeGenerated += f.code_generation_activity_count || 0;
      features[f.feature].locAdded += f.loc_added_sum || 0;
    }
  }
  return Object.entries(features)
    .map(([feature, d]) => ({ feature, ...d }))
    .sort((a, b) => b.interactions - a.interactions);
}

function aggregateByLanguage() {
  const langs = {};
  for (const r of records) {
    for (const l of r.totals_by_language_feature || []) {
      if (!langs[l.language]) {
        langs[l.language] = { codeGenerated: 0, locAdded: 0 };
      }
      langs[l.language].codeGenerated += l.code_generation_activity_count || 0;
      langs[l.language].locAdded += l.loc_added_sum || 0;
    }
  }
  return Object.entries(langs)
    .map(([language, d]) => ({ language, ...d }))
    .sort((a, b) => b.codeGenerated - a.codeGenerated)
    .slice(0, 15);
}

function aggregateByModel() {
  const models = {};
  for (const r of records) {
    for (const m of r.totals_by_model_feature || []) {
      if (!models[m.model]) {
        models[m.model] = { interactions: 0, codeGenerated: 0 };
      }
      models[m.model].interactions += m.user_initiated_interaction_count || 0;
      models[m.model].codeGenerated += m.code_generation_activity_count || 0;
    }
  }
  return Object.entries(models)
    .map(([model, d]) => ({ model, ...d }))
    .sort((a, b) => b.interactions - a.interactions)
    .slice(0, 15);
}

function aggregateByIDE() {
  const ides = {};
  for (const r of records) {
    for (const i of r.totals_by_ide || []) {
      if (!ides[i.ide]) {
        ides[i.ide] = { interactions: 0, codeGenerated: 0 };
      }
      ides[i.ide].interactions += i.user_initiated_interaction_count || 0;
      ides[i.ide].codeGenerated += i.code_generation_activity_count || 0;
    }
  }
  return Object.entries(ides)
    .map(([ide, d]) => ({ ide, interactions: d.interactions, codeGenerated: d.codeGenerated }))
    .sort((a, b) => b.interactions - a.interactions);
}

function aggregateTopUsers(limit = 50) {
  // Enterprise-level data does not include per-user breakdowns
  return [];
}

function getUserData(username) {
  // Enterprise-level data does not include per-user breakdowns
  return null;
}

// ─── Report Generation ─────────────────────────────────────────────────────

function fmt(n) {
  return n.toLocaleString('en-US');
}

function fmtShort(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'b';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

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

function getSortedDays() {
  const daySet = new Set(records.map(r => r.day));
  return Array.from(daySet).sort();
}

function getRecordsByDay() {
  const byDay = {};
  for (const r of records) {
    if (!byDay[r.day]) byDay[r.day] = [];
    byDay[r.day].push(r);
  }
  return byDay;
}

function topN(arr, key, n = 5) {
  const sorted = [...arr].sort((a, b) => b[key] - a[key]);
  const top = sorted.slice(0, n);
  const rest = sorted.slice(n);
  const otherVal = rest.reduce((s, x) => s + x[key], 0);
  return { top, otherVal };
}

function aggregateDailyActiveUsers() {
  return getSortedDays().map(day => {
    const rec = records.find(r => r.day === day);
    return { day, users: rec ? (rec.daily_active_users || 0) : 0 };
  });
}

function aggregateWeeklyActiveUsers() {
  const days = getSortedDays();
  const dauByDay = {};
  for (const r of records) {
    dauByDay[r.day] = r.daily_active_users || 0;
  }
  return days.map((day, idx) => {
    // 7-day rolling average of daily active users
    const windowDays = days.slice(Math.max(0, idx - 6), idx + 1);
    const sum = windowDays.reduce((s, d) => s + (dauByDay[d] || 0), 0);
    return { day, users: Math.round(sum / windowDays.length) };
  });
}

function aggregateAvgChatRequestsPerActiveUser() {
  return getSortedDays().map(day => {
    const rec = records.find(r => r.day === day);
    if (!rec) return { day, avg: 0 };
    let totalChat = 0;
    for (const f of (rec.totals_by_feature || [])) {
      if (f.feature !== 'code_completion') {
        totalChat += f.user_initiated_interaction_count || 0;
      }
    }
    const dau = rec.daily_active_users || 1;
    return { day, avg: Math.round((totalChat / dau) * 100) / 100 };
  });
}

function aggregateRequestsPerChatMode() {
  const byDay = getRecordsByDay();
  const days = getSortedDays();
  const series = {};
  for (const feat of CHAT_MODES) {
    series[FEATURE_DISPLAY[feat]] = [];
  }
  for (const day of days) {
    const counts = {};
    for (const feat of CHAT_MODES) counts[FEATURE_DISPLAY[feat]] = 0;
    for (const r of byDay[day]) {
      for (const f of (r.totals_by_feature || [])) {
        if (CHAT_MODES.includes(f.feature)) {
          counts[FEATURE_DISPLAY[f.feature]] += f.user_initiated_interaction_count || 0;
        }
      }
    }
    for (const name of Object.keys(series)) {
      series[name].push(counts[name]);
    }
  }
  return { days, series };
}

function aggregateCodeCompletions() {
  const byDay = getRecordsByDay();
  return getSortedDays().map(day => {
    let shown = 0, accepted = 0;
    for (const r of byDay[day]) {
      for (const f of (r.totals_by_feature || [])) {
        if (f.feature === 'code_completion') {
          shown += f.code_generation_activity_count || 0;
          accepted += f.code_acceptance_activity_count || 0;
        }
      }
    }
    return { day, shown, accepted };
  });
}

function aggregateCodeCompletionAcceptanceRate() {
  return aggregateCodeCompletions().map(d => ({
    day: d.day,
    rate: d.shown > 0 ? Math.round((d.accepted / d.shown) * 10000) / 100 : 0,
  }));
}

function aggregateModelUsagePerDay() {
  const byDay = getRecordsByDay();
  const days = getSortedDays();
  const modelTotals = {};
  for (const r of records) {
    for (const m of (r.totals_by_model_feature || [])) {
      const cnt = (m.user_initiated_interaction_count || 0) + (m.code_generation_activity_count || 0);
      modelTotals[m.model] = (modelTotals[m.model] || 0) + cnt;
    }
  }
  const sorted = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]);
  const topModels = sorted.slice(0, 5).map(e => e[0]);

  const series = {};
  for (const m of topModels) series[m] = [];
  series['Other'] = [];

  for (const day of days) {
    const dayCounts = {};
    for (const m of topModels) dayCounts[m] = 0;
    dayCounts['Other'] = 0;
    for (const r of byDay[day]) {
      for (const m of (r.totals_by_model_feature || [])) {
        const cnt = (m.user_initiated_interaction_count || 0) + (m.code_generation_activity_count || 0);
        if (topModels.includes(m.model)) {
          dayCounts[m.model] += cnt;
        } else {
          dayCounts['Other'] += cnt;
        }
      }
    }
    const total = Object.values(dayCounts).reduce((s, v) => s + v, 0);
    for (const key of [...topModels, 'Other']) {
      series[key].push(total > 0 ? Math.round((dayCounts[key] / total) * 10000) / 100 : 0);
    }
  }
  return { days, series };
}

function aggregateChatModelDistribution() {
  const modelCounts = {};
  for (const r of records) {
    for (const m of (r.totals_by_model_feature || [])) {
      if (m.feature !== 'code_completion') {
        const cnt = (m.user_initiated_interaction_count || 0);
        modelCounts[m.model] = (modelCounts[m.model] || 0) + cnt;
      }
    }
  }
  return Object.entries(modelCounts)
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);
}

function aggregateModelUsagePerChatMode() {
  const modelTotals = {};
  for (const r of records) {
    for (const m of (r.totals_by_model_feature || [])) {
      if (CHAT_MODES.includes(m.feature)) {
        modelTotals[m.model] = (modelTotals[m.model] || 0) + (m.user_initiated_interaction_count || 0);
      }
    }
  }
  const sorted = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]);
  const topModels = sorted.slice(0, 5).map(e => e[0]);

  const data = {};
  for (const feat of CHAT_MODES) {
    data[FEATURE_DISPLAY[feat]] = {};
    for (const m of topModels) data[FEATURE_DISPLAY[feat]][m] = 0;
    data[FEATURE_DISPLAY[feat]]['Other'] = 0;
  }
  for (const r of records) {
    for (const m of (r.totals_by_model_feature || [])) {
      if (CHAT_MODES.includes(m.feature)) {
        const displayFeat = FEATURE_DISPLAY[m.feature];
        const cnt = m.user_initiated_interaction_count || 0;
        if (topModels.includes(m.model)) {
          data[displayFeat][m.model] += cnt;
        } else {
          data[displayFeat]['Other'] += cnt;
        }
      }
    }
  }
  // Convert to % per chat mode
  const labels = CHAT_MODES.map(f => FEATURE_DISPLAY[f]);
  const seriesKeys = [...topModels, 'Other'];
  const datasets = seriesKeys.map(model => ({
    label: model,
    data: labels.map(feat => {
      const total = Object.values(data[feat]).reduce((s, v) => s + v, 0);
      return total > 0 ? Math.round((data[feat][model] / total) * 10000) / 100 : 0;
    }),
  }));
  return { labels, datasets };
}

function aggregateLanguageUsagePerDay() {
  const byDay = getRecordsByDay();
  const days = getSortedDays();
  const langTotals = {};
  for (const r of records) {
    for (const l of (r.totals_by_language_feature || [])) {
      langTotals[l.language] = (langTotals[l.language] || 0) + (l.code_generation_activity_count || 0);
    }
  }
  const sorted = Object.entries(langTotals).sort((a, b) => b[1] - a[1]);
  const topLangs = sorted.slice(0, 5).map(e => e[0]);

  const series = {};
  for (const l of topLangs) series[l] = [];
  series['Other'] = [];

  for (const day of days) {
    const dayCounts = {};
    for (const l of topLangs) dayCounts[l] = 0;
    dayCounts['Other'] = 0;
    for (const r of byDay[day]) {
      for (const l of (r.totals_by_language_feature || [])) {
        if (topLangs.includes(l.language)) {
          dayCounts[l.language] += l.code_generation_activity_count || 0;
        } else {
          dayCounts['Other'] += l.code_generation_activity_count || 0;
        }
      }
    }
    const total = Object.values(dayCounts).reduce((s, v) => s + v, 0);
    for (const key of [...topLangs, 'Other']) {
      series[key].push(total > 0 ? Math.round((dayCounts[key] / total) * 10000) / 100 : 0);
    }
  }
  return { days, series };
}

function aggregateLanguageDistribution() {
  const langCounts = {};
  for (const r of records) {
    for (const l of (r.totals_by_language_feature || [])) {
      langCounts[l.language] = (langCounts[l.language] || 0) + (l.code_generation_activity_count || 0);
    }
  }
  return Object.entries(langCounts)
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);
}

function aggregateModelUsagePerLanguage() {
  const langTotals = {};
  for (const r of records) {
    for (const l of (r.totals_by_language_model || [])) {
      langTotals[l.language] = (langTotals[l.language] || 0) + (l.code_generation_activity_count || 0);
    }
  }
  const sortedLangs = Object.entries(langTotals).sort((a, b) => b[1] - a[1]);
  const topLangs = sortedLangs.slice(0, 5).map(e => e[0]);

  const modelTotals = {};
  for (const r of records) {
    for (const l of (r.totals_by_language_model || [])) {
      if (topLangs.includes(l.language)) {
        modelTotals[l.model] = (modelTotals[l.model] || 0) + (l.code_generation_activity_count || 0);
      }
    }
  }
  const sortedModels = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]);
  const topModels = sortedModels.slice(0, 5).map(e => e[0]);

  const data = {};
  for (const lang of topLangs) {
    data[lang] = {};
    for (const m of topModels) data[lang][m] = 0;
    data[lang]['Other'] = 0;
  }
  for (const r of records) {
    for (const l of (r.totals_by_language_model || [])) {
      if (topLangs.includes(l.language)) {
        const cnt = l.code_generation_activity_count || 0;
        if (topModels.includes(l.model)) {
          data[l.language][l.model] += cnt;
        } else {
          data[l.language]['Other'] += cnt;
        }
      }
    }
  }
  const labels = topLangs;
  const seriesKeys = [...topModels, 'Other'];
  const datasets = seriesKeys.map(model => ({
    label: model,
    data: labels.map(lang => {
      const total = Object.values(data[lang]).reduce((s, v) => s + v, 0);
      return total > 0 ? Math.round((data[lang][model] / total) * 10000) / 100 : 0;
    }),
  }));
  return { labels, datasets };
}

function aggregateDailyLocAddedDeleted() {
  const byDay = getRecordsByDay();
  return getSortedDays().map(day => {
    let added = 0, deleted = 0;
    for (const r of byDay[day]) {
      added += r.loc_added_sum || 0;
      deleted += r.loc_deleted_sum || 0;
    }
    return { day, added, deleted };
  });
}

function aggregateUserInitiatedCodeChanges() {
  let suggested = 0, added = 0;
  for (const r of records) {
    for (const f of (r.totals_by_feature || [])) {
      if (USER_INITIATED_FEATURES.includes(f.feature)) {
        suggested += f.loc_suggested_to_add_sum || 0;
        added += f.loc_added_sum || 0;
      }
    }
  }
  return { suggested, added };
}

function aggregateAgentInitiatedCodeChanges() {
  let added = 0, deleted = 0;
  for (const r of records) {
    for (const f of (r.totals_by_feature || [])) {
      if (AGENT_FEATURES.includes(f.feature)) {
        added += f.loc_added_sum || 0;
        deleted += f.loc_deleted_sum || 0;
      }
    }
  }
  return { added, deleted };
}

function aggregateUserCodeChangesByModel() {
  const models = {};
  for (const r of records) {
    for (const m of (r.totals_by_model_feature || [])) {
      if (!AGENT_FEATURES.includes(m.feature)) {
        if (!models[m.model]) models[m.model] = { suggested: 0, added: 0 };
        models[m.model].suggested += m.loc_suggested_to_add_sum || 0;
        models[m.model].added += m.loc_added_sum || 0;
      }
    }
  }
  return Object.entries(models)
    .map(([model, d]) => ({ model, ...d }))
    .sort((a, b) => (b.suggested + b.added) - (a.suggested + a.added));
}

function aggregateAgentCodeChangesByModel() {
  const models = {};
  for (const r of records) {
    for (const m of (r.totals_by_model_feature || [])) {
      if (AGENT_FEATURES.includes(m.feature)) {
        if (!models[m.model]) models[m.model] = { added: 0, deleted: 0 };
        models[m.model].added += m.loc_added_sum || 0;
        models[m.model].deleted += m.loc_deleted_sum || 0;
      }
    }
  }
  return Object.entries(models)
    .map(([model, d]) => ({ model, ...d }))
    .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
}

function aggregateUserCodeChangesByLanguage() {
  const langs = {};
  for (const r of records) {
    for (const l of (r.totals_by_language_feature || [])) {
      if (!AGENT_FEATURES.includes(l.feature)) {
        if (!langs[l.language]) langs[l.language] = { suggested: 0, added: 0 };
        langs[l.language].suggested += l.loc_suggested_to_add_sum || 0;
        langs[l.language].added += l.loc_added_sum || 0;
      }
    }
  }
  return Object.entries(langs)
    .map(([language, d]) => ({ language, ...d }))
    .sort((a, b) => (b.suggested + b.added) - (a.suggested + a.added));
}

function aggregateAgentCodeChangesByLanguage() {
  const langs = {};
  for (const r of records) {
    for (const l of (r.totals_by_language_feature || [])) {
      if (AGENT_FEATURES.includes(l.feature)) {
        if (!langs[l.language]) langs[l.language] = { added: 0, deleted: 0 };
        langs[l.language].added += l.loc_added_sum || 0;
        langs[l.language].deleted += l.loc_deleted_sum || 0;
      }
    }
  }
  return Object.entries(langs)
    .map(([language, d]) => ({ language, ...d }))
    .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
}

function generateReports() {
  const period = getDateRange();
  const allUsers = getUniqueUsers();
  const totalInteractions = sumField('user_initiated_interaction_count');
  const totalCodeGenerated = sumField('code_generation_activity_count');
  const totalLocAdded = sumField('loc_added_sum');
  const totalLocDeleted = sumField('loc_deleted_sum');
  const activeUsers = allUsers.size; // max DAU
  const totalDays = records.length;
  // Compute agent/chat activity from totals_by_feature
  let totalAgentActivity = 0, totalChatActivity = 0;
  for (const r of records) {
    for (const f of (r.totals_by_feature || [])) {
      if (AGENT_FEATURES.includes(f.feature)) {
        totalAgentActivity += (f.user_initiated_interaction_count || 0) + (f.code_generation_activity_count || 0);
      }
      if (CHAT_MODES.includes(f.feature)) {
        totalChatActivity += (f.user_initiated_interaction_count || 0);
      }
    }
  }
  const trends = aggregateByDay();
  const features = aggregateByFeature();
  const languages = aggregateByLanguage();
  const models = aggregateByModel();
  const ides = aggregateByIDE();
  const topUsers = aggregateTopUsers(20);

  // ── Copilot Usage Dashboard ──
  {
    const dailyActive = aggregateDailyActiveUsers();
    const weeklyActive = aggregateWeeklyActiveUsers();
    const avgChat = aggregateAvgChatRequestsPerActiveUser();
    const chatMode = aggregateRequestsPerChatMode();
    const completions = aggregateCodeCompletions();
    const acceptRate = aggregateCodeCompletionAcceptanceRate();
    const modelPerDay = aggregateModelUsagePerDay();
    const chatModelDist = aggregateChatModelDistribution();
    const modelPerChatMode = aggregateModelUsagePerChatMode();
    const langPerDay = aggregateLanguageUsagePerDay();
    const langDist = aggregateLanguageDistribution();
    const modelPerLang = aggregateModelUsagePerLanguage();

    // KPI: Max Daily Active Users in period
    const maxDau = records.reduce((m, r) => Math.max(m, r.daily_active_users || 0), 0);
    const avgDau = records.length > 0 ? Math.round(records.reduce((s, r) => s + (r.daily_active_users || 0), 0) / records.length) : 0;
    // KPI: Agent Adoption (% of total activity from agent features)
    let totalActivity = 0, agentActivity = 0;
    for (const r of records) {
      for (const f of (r.totals_by_feature || [])) {
        const act = (f.user_initiated_interaction_count || 0) + (f.code_generation_activity_count || 0);
        totalActivity += act;
        if (AGENT_FEATURES.includes(f.feature)) agentActivity += act;
      }
    }
    const agentAdoptionPct = totalActivity > 0 ? ((agentActivity / totalActivity) * 100).toFixed(1) : '0.0';
    // KPI: Most Used Chat Model
    const mostUsedChatModel = chatModelDist.length > 0 ? chatModelDist[0].model : 'N/A';

    preGeneratedReports['copilot-usage'] = {
      markdown: [
        `# Copilot IDE Usage`,
        ``,
        `| Avg Daily Active Users | Peak DAU | Agent Activity | Most Used Chat Model |`,
        `|:---:|:---:|:---:|:---:|`,
        `| **${fmt(avgDau)}** | **${fmt(maxDau)}** | **${agentAdoptionPct}%** of total | **${mostUsedChatModel}** |`,
      ].join('\n'),
      chartData: null,
      chartsData: [
        {
          title: 'IDE Daily Active Users',
          type: 'line',
          labels: dailyActive.map(d => d.day),
          datasets: [{ label: 'Active Users', data: dailyActive.map(d => d.users) }],
        },
        {
          title: 'IDE Weekly Active Users',
          type: 'line',
          labels: weeklyActive.map(d => d.day),
          datasets: [{ label: 'Weekly Active Users', data: weeklyActive.map(d => d.users) }],
        },
        {
          title: 'Average Chat Requests per Active User',
          type: 'line',
          labels: avgChat.map(d => d.day),
          datasets: [{ label: 'Avg Requests', data: avgChat.map(d => d.avg) }],
        },
        {
          title: 'Requests per Chat Mode',
          type: 'bar',
          stacked: true,
          labels: chatMode.days,
          datasets: Object.entries(chatMode.series).map(([label, data]) => ({ label, data })),
        },
        {
          title: 'Code Completions',
          type: 'line',
          labels: completions.map(d => d.day),
          datasets: [
            { label: 'Shown', data: completions.map(d => d.shown) },
            { label: 'Accepted', data: completions.map(d => d.accepted) },
          ],
        },
        {
          title: 'Code Completions Acceptance Rate',
          type: 'line',
          labels: acceptRate.map(d => d.day),
          datasets: [{ label: 'Acceptance Rate (%)', data: acceptRate.map(d => d.rate) }],
        },
        {
          title: 'Model Usage per Day',
          type: 'bar',
          stacked: true,
          labels: modelPerDay.days,
          datasets: Object.entries(modelPerDay.series).map(([label, data]) => ({ label, data })),
        },
        {
          title: 'Chat Model Usage',
          type: 'pie',
          labels: chatModelDist.map(d => d.model),
          datasets: [{ label: 'Interactions', data: chatModelDist.map(d => d.count) }],
        },
        {
          title: 'Model Usage per Chat Mode',
          type: 'bar',
          labels: modelPerChatMode.labels,
          datasets: modelPerChatMode.datasets,
        },
        {
          title: 'Language Usage per Day',
          type: 'bar',
          stacked: true,
          labels: langPerDay.days,
          datasets: Object.entries(langPerDay.series).map(([label, data]) => ({ label, data })),
        },
        {
          title: 'Language Usage',
          type: 'pie',
          labels: langDist.map(d => d.language),
          datasets: [{ label: 'Code Generations', data: langDist.map(d => d.count) }],
        },
        {
          title: 'Model Usage per Language',
          type: 'bar',
          labels: modelPerLang.labels,
          datasets: modelPerLang.datasets,
        },
      ],
    };
  }

  // ── Code Generation Dashboard ──
  {
    const dailyLoc = aggregateDailyLocAddedDeleted();
    const userChanges = aggregateUserInitiatedCodeChanges();
    const agentChanges = aggregateAgentInitiatedCodeChanges();
    const userByModel = aggregateUserCodeChangesByModel();
    const agentByModel = aggregateAgentCodeChangesByModel();
    const userByLang = aggregateUserCodeChangesByLanguage();
    const agentByLang = aggregateAgentCodeChangesByLanguage();

    // KPI: Total LOC changed
    const totalLocChanged = totalLocAdded + totalLocDeleted;
    // KPI: Agent Contribution %
    const agentLocTotal = agentChanges.added + agentChanges.deleted;
    const agentContribPct = totalLocChanged > 0 ? ((agentLocTotal / totalLocChanged) * 100).toFixed(1) : '0.0';
    // KPI: Avg lines deleted by agent per day
    const avgAgentDeletedPerDay = totalDays > 0 ? Math.round(agentChanges.deleted / totalDays) : 0;

    preGeneratedReports['code-generation'] = {
      markdown: [
        `# IDE Code Generation`,
        ``,
        `| Lines of Code Changed with AI | Agent Contribution | Avg Agent Deletions/Day |`,
        `|:---:|:---:|:---:|`,
        `| **${fmtShort(totalLocChanged)}** (${fmt(totalLocChanged)}) | **${agentContribPct}%** | **${fmt(avgAgentDeletedPerDay)}** |`,
      ].join('\n'),
      chartData: null,
      chartsData: [
        {
          title: 'Daily Total of Lines Added and Deleted',
          type: 'bar',
          labels: dailyLoc.map(d => d.day),
          datasets: [
            { label: 'Added', data: dailyLoc.map(d => d.added) },
            { label: 'Deleted', data: dailyLoc.map(d => d.deleted) },
          ],
        },
        {
          title: 'User-Initiated Code Changes',
          type: 'bar',
          labels: ['Suggested to Add', 'Actually Added'],
          datasets: [{ label: 'Lines of Code', data: [userChanges.suggested, userChanges.added] }],
        },
        {
          title: 'Agent-Initiated Code Changes',
          type: 'bar',
          labels: ['Added', 'Deleted'],
          datasets: [{ label: 'Lines of Code', data: [agentChanges.added, agentChanges.deleted] }],
        },
        {
          title: 'User-Initiated Code Changes per Model',
          type: 'bar',
          labels: userByModel.map(m => m.model),
          datasets: [
            { label: 'Suggested', data: userByModel.map(m => m.suggested) },
            { label: 'Added', data: userByModel.map(m => m.added) },
          ],
        },
        {
          title: 'Agent-Initiated Code Changes per Model',
          type: 'bar',
          labels: agentByModel.map(m => m.model),
          datasets: [
            { label: 'Added', data: agentByModel.map(m => m.added) },
            { label: 'Deleted', data: agentByModel.map(m => m.deleted) },
          ],
        },
        {
          title: 'User-Initiated Code Changes per Language',
          type: 'bar',
          labels: userByLang.map(l => l.language),
          datasets: [
            { label: 'Suggested', data: userByLang.map(l => l.suggested) },
            { label: 'Added', data: userByLang.map(l => l.added) },
          ],
        },
        {
          title: 'Agent-Initiated Code Changes per Language',
          type: 'bar',
          labels: agentByLang.map(l => l.language),
          datasets: [
            { label: 'Added', data: agentByLang.map(l => l.added) },
            { label: 'Deleted', data: agentByLang.map(l => l.deleted) },
          ],
        },
      ],
    };
  }

  // Executive Summary
  preGeneratedReports['executive-summary'] = {
    markdown: [
      `# 📊 Executive Summary`,
      `**Period:** ${period.start} to ${period.end}\n`,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Peak Daily Active Users | ${fmt(allUsers.size)} |`,
      `| Total Interactions | ${fmt(totalInteractions)} |`,
      `| Code Generations | ${fmt(totalCodeGenerated)} |`,
      `| Lines Added | ${fmt(totalLocAdded)} |`,
      `| Lines Deleted | ${fmt(totalLocDeleted)} |`,
      `| Agent Activity (interactions) | ${fmt(totalAgentActivity)} |`,
      `| Chat Activity (interactions) | ${fmt(totalChatActivity)} |`,
      ``,
      `## Key Insights`,
      `- Average **${activeUsers > 0 ? (totalInteractions / activeUsers).toFixed(1) : 0}** interactions per active user per day.`,
      `- Agent features account for **${totalInteractions > 0 ? ((totalAgentActivity / (totalInteractions + totalCodeGenerated)) * 100).toFixed(1) : 0}%** of total activity.`,
      `- Average **${activeUsers > 0 ? Math.round(totalLocAdded / totalDays) : 0}** lines of code added per day.`,
    ].join('\n'),
    chartData: {
      type: 'doughnut',
      labels: ['Interactions', 'Code Generations'],
      datasets: [{
        label: 'Activity Split',
        data: [totalInteractions, totalCodeGenerated],
      }],
    },
  };

  // Usage Trends
  preGeneratedReports['usage-trends'] = {
    markdown: [
      `# 📈 Usage Trends`,
      `**Period:** ${period.start} to ${period.end}\n`,
      `| Day | Active Users | Interactions | Code Generated | LOC Added |`,
      `|-----|-------------|-------------|----------------|-----------|`,
      ...trends.map(t =>
        `| ${t.day} | ${fmt(t.activeUsers)} | ${fmt(t.interactions)} | ${fmt(t.codeGenerated)} | ${fmt(t.locAdded)} |`
      ),
      ``,
      `## Summary`,
      `- Peak active users: **${fmt(Math.max(...trends.map(t => t.activeUsers)))}** on ${trends.reduce((a, b) => a.activeUsers > b.activeUsers ? a : b).day}`,
      `- Peak interactions: **${fmt(Math.max(...trends.map(t => t.interactions)))}** on ${trends.reduce((a, b) => a.interactions > b.interactions ? a : b).day}`,
    ].join('\n'),
    chartData: {
      type: 'line',
      labels: trends.map(t => t.day),
      datasets: [
        { label: 'Active Users', data: trends.map(t => t.activeUsers) },
        { label: 'Interactions', data: trends.map(t => t.interactions) },
      ],
    },
  };

  // Feature Adoption
  preGeneratedReports['feature-adoption'] = {
    markdown: [
      `# 🤖 Feature Adoption`,
      `\n| Feature | Interactions | Code Generated | LOC Added |`,
      `|---------|-------------|----------------|-----------|`,
      ...features.map(f =>
        `| ${f.feature} | ${fmt(f.interactions)} | ${fmt(f.codeGenerated)} | ${fmt(f.locAdded)} |`
      ),
      ``,
      `## Insights`,
      `- Most used feature: **${features[0]?.feature}** with ${fmt(features[0]?.interactions || 0)} interactions.`,
      `- ${features.length} distinct features in use across the organization.`,
    ].join('\n'),
    chartData: {
      type: 'bar',
      labels: features.map(f => f.feature),
      datasets: [
        { label: 'Interactions', data: features.map(f => f.interactions) },
        { label: 'Code Generated', data: features.map(f => f.codeGenerated) },
      ],
    },
  };

  // Language Breakdown
  preGeneratedReports['language-breakdown'] = {
    markdown: [
      `# 💻 Language Breakdown`,
      `\nTop 15 languages by code generation activity.\n`,
      `| Language | Code Generated | LOC Added |`,
      `|----------|----------------|-----------|`,
      ...languages.map(l =>
        `| ${l.language} | ${fmt(l.codeGenerated)} | ${fmt(l.locAdded)} |`
      ),
    ].join('\n'),
    chartData: {
      type: 'bar',
      labels: languages.map(l => l.language),
      datasets: [
        { label: 'Code Generated', data: languages.map(l => l.codeGenerated) },
        { label: 'LOC Added', data: languages.map(l => l.locAdded) },
      ],
    },
  };

  // Model Usage
  preGeneratedReports['model-usage'] = {
    markdown: [
      `# 🧠 Model Usage`,
      `\nTop 15 models by interaction count.\n`,
      `| Model | Interactions | Code Generated |`,
      `|-------|-------------|----------------|`,
      ...models.map(m =>
        `| ${m.model} | ${fmt(m.interactions)} | ${fmt(m.codeGenerated)} |`
      ),
    ].join('\n'),
    chartData: {
      type: 'bar',
      labels: models.map(m => m.model),
      datasets: [
        { label: 'Interactions', data: models.map(m => m.interactions) },
        { label: 'Code Generated', data: models.map(m => m.codeGenerated) },
      ],
    },
  };

  // IDE Distribution
  preGeneratedReports['ide-distribution'] = {
    markdown: [
      `# 🖥️ IDE Distribution`,
      `\n| IDE | Interactions | Code Generated |`,
      `|-----|-------------|----------------|`,
      ...ides.map(i =>
        `| ${i.ide} | ${fmt(i.interactions)} | ${fmt(i.codeGenerated)} |`
      ),
    ].join('\n'),
    chartData: {
      type: 'pie',
      labels: ides.map(i => i.ide),
      datasets: [{
        label: 'Interactions',
        data: ides.map(i => i.interactions),
      }],
    },
  };

  // Top Users (not available in enterprise-level data)
  preGeneratedReports['top-users'] = {
    markdown: [
      `# 🏆 Top Users`,
      `\n> Per-user data is not available in enterprise-level reports. This report requires the user-level Copilot metrics export.\n`,
      `## Enterprise Summary`,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Peak Daily Active Users | ${fmt(allUsers.size)} |`,
      `| Total Interactions | ${fmt(totalInteractions)} |`,
      `| Total Code Generations | ${fmt(totalCodeGenerated)} |`,
    ].join('\n'),
    chartData: null,
  };

  console.log(`Generated ${Object.keys(preGeneratedReports).length} standard reports`);
}

// ─── Query Handler ──────────────────────────────────────────────────────────

function handleQuery(prompt) {
  const lower = prompt.toLowerCase();

  // Detect report/dashboard creation requests and return rich multi-chart responses
  const isReport = /\b(generate|create|build|make|produce|give me)\b.*\b(report|dashboard|breakdown|analysis|overview)\b/i.test(prompt);

  if (isReport) {
    // Determine what the report is about and compose a multi-chart response
    if (lower.includes('language') || lower.includes('lang')) {
      const langDist = aggregateLanguageDistribution();
      const langPerDay = aggregateLanguageUsagePerDay();
      const userByLang = aggregateUserCodeChangesByLanguage().slice(0, 10);
      const agentByLang = aggregateAgentCodeChangesByLanguage().slice(0, 10);
      const top = langDist.slice(0, 10);
      return {
        markdown: [
          `# Language Adoption Report`,
          `\n| Language | Code Generations | % of Total |`,
          `|----------|-----------------|------------|`,
          ...top.map(l => {
            const total = langDist.reduce((s, x) => s + x.count, 0);
            return `| ${l.language} | ${fmt(l.count)} | ${(l.count / total * 100).toFixed(1)}% |`;
          }),
        ].join('\n'),
        chartData: null,
        chartsData: [
          { title: 'Language Distribution', type: 'pie', labels: top.map(l => l.language), datasets: [{ label: 'Code Generations', data: top.map(l => l.count) }] },
          { title: 'Language Usage Trend (%)', type: 'bar', stacked: true, labels: langPerDay.days, datasets: Object.entries(langPerDay.series).map(([label, data]) => ({ label, data })) },
          { title: 'User-Initiated LOC by Language', type: 'bar', labels: userByLang.map(l => l.language), datasets: [{ label: 'Suggested', data: userByLang.map(l => l.suggested) }, { label: 'Added', data: userByLang.map(l => l.added) }] },
          { title: 'Agent-Initiated LOC by Language', type: 'bar', labels: agentByLang.map(l => l.language), datasets: [{ label: 'Added', data: agentByLang.map(l => l.added) }, { label: 'Deleted', data: agentByLang.map(l => l.deleted) }] },
        ],
      };
    }
    if (lower.includes('model')) {
      const modelDist = aggregateChatModelDistribution();
      const modelPerDay = aggregateModelUsagePerDay();
      const modelPerChat = aggregateModelUsagePerChatMode();
      const agentByModel = aggregateAgentCodeChangesByModel().slice(0, 10);
      const top = modelDist.slice(0, 10);
      return {
        markdown: [
          `# Model Usage Report`,
          `\n| Model | Interactions | % of Total |`,
          `|-------|-------------|------------|`,
          ...top.map(m => {
            const total = modelDist.reduce((s, x) => s + x.count, 0);
            return `| ${m.model} | ${fmt(m.count)} | ${(m.count / total * 100).toFixed(1)}% |`;
          }),
        ].join('\n'),
        chartData: null,
        chartsData: [
          { title: 'Chat Model Distribution', type: 'pie', labels: top.map(m => m.model), datasets: [{ label: 'Interactions', data: top.map(m => m.count) }] },
          { title: 'Model Usage Trend (%)', type: 'bar', stacked: true, labels: modelPerDay.days, datasets: Object.entries(modelPerDay.series).map(([label, data]) => ({ label, data })) },
          { title: 'Model Usage per Chat Mode (%)', type: 'bar', labels: modelPerChat.labels, datasets: modelPerChat.datasets },
          { title: 'Agent LOC by Model', type: 'bar', labels: agentByModel.map(m => m.model), datasets: [{ label: 'Added', data: agentByModel.map(m => m.added) }, { label: 'Deleted', data: agentByModel.map(m => m.deleted) }] },
        ],
      };
    }
    if (lower.includes('agent') || lower.includes('adoption') || lower.includes('feature')) {
      const features = aggregateByFeature();
      const chatMode = aggregateRequestsPerChatMode();
      const agentChanges = aggregateAgentInitiatedCodeChanges();
      const userChanges = aggregateUserInitiatedCodeChanges();
      const totalLoc = sumField('loc_added_sum') + sumField('loc_deleted_sum');
      const agentPct = totalLoc > 0 ? ((agentChanges.added + agentChanges.deleted) / totalLoc * 100).toFixed(1) : '0';
      return {
        markdown: [
          `# Feature & Agent Adoption Report`,
          `\n| Feature | Interactions | Code Generated | LOC Added |`,
          `|---------|-------------|----------------|-----------|`,
          ...features.map(f => `| ${FEATURE_DISPLAY[f.feature] || f.feature} | ${fmt(f.interactions)} | ${fmt(f.codeGenerated)} | ${fmt(f.locAdded)} |`),
          `\n> **Agent Contribution:** ${agentPct}% of all lines changed`,
        ].join('\n'),
        chartData: null,
        chartsData: [
          { title: 'Interactions by Feature', type: 'bar', labels: features.map(f => FEATURE_DISPLAY[f.feature] || f.feature), datasets: [{ label: 'Interactions', data: features.map(f => f.interactions) }] },
          { title: 'Requests per Chat Mode (Daily)', type: 'bar', stacked: true, labels: chatMode.days, datasets: Object.entries(chatMode.series).map(([label, data]) => ({ label, data })) },
          { title: 'User vs Agent Code Changes', type: 'bar', labels: ['User Suggested', 'User Added', 'Agent Added', 'Agent Deleted'], datasets: [{ label: 'Lines of Code', data: [userChanges.suggested, userChanges.added, agentChanges.added, agentChanges.deleted] }] },
          { title: 'Feature LOC Contribution', type: 'pie', labels: features.map(f => FEATURE_DISPLAY[f.feature] || f.feature), datasets: [{ label: 'LOC Added', data: features.map(f => f.locAdded) }] },
        ],
      };
    }
    if (lower.includes('trend') || lower.includes('usage') || lower.includes('active') || lower.includes('daily') || lower.includes('weekly')) {
      const dailyActive = aggregateDailyActiveUsers();
      const weeklyActive = aggregateWeeklyActiveUsers();
      const avgChat = aggregateAvgChatRequestsPerActiveUser();
      const completions = aggregateCodeCompletions();
      return {
        markdown: [
          `# Usage Trends Report`,
          `\n**Period:** ${getDateRange().start} to ${getDateRange().end}`,
          `\n- Peak daily active users: **${fmt(Math.max(...dailyActive.map(d => d.users)))}**`,
          `- Peak weekly active users: **${fmt(Math.max(...weeklyActive.map(d => d.users)))}**`,
          `- Average chat requests per user: **${(avgChat.reduce((s, d) => s + d.avg, 0) / avgChat.length).toFixed(1)}**`,
        ].join('\n'),
        chartData: null,
        chartsData: [
          { title: 'Daily Active Users', type: 'line', labels: dailyActive.map(d => d.day), datasets: [{ label: 'Active Users', data: dailyActive.map(d => d.users) }] },
          { title: 'Weekly Active Users (7-day rolling)', type: 'line', labels: weeklyActive.map(d => d.day), datasets: [{ label: 'Weekly Active', data: weeklyActive.map(d => d.users) }] },
          { title: 'Avg Chat Requests per Active User', type: 'line', labels: avgChat.map(d => d.day), datasets: [{ label: 'Avg Requests', data: avgChat.map(d => d.avg) }] },
          { title: 'Code Completions (Shown vs Accepted)', type: 'line', labels: completions.map(d => d.day), datasets: [{ label: 'Shown', data: completions.map(d => d.shown) }, { label: 'Accepted', data: completions.map(d => d.accepted) }] },
        ],
      };
    }
    if (lower.includes('code') || lower.includes('loc') || lower.includes('line')) {
      const dailyLoc = aggregateDailyLocAddedDeleted();
      const userChanges = aggregateUserInitiatedCodeChanges();
      const agentChanges = aggregateAgentInitiatedCodeChanges();
      const agentByModel = aggregateAgentCodeChangesByModel().slice(0, 8);
      return {
        markdown: [
          `# Code Generation Report`,
          `\n| Metric | Value |`,
          `|--------|-------|`,
          `| Total Lines Added | ${fmt(sumField('loc_added_sum'))} |`,
          `| Total Lines Deleted | ${fmt(sumField('loc_deleted_sum'))} |`,
          `| User-Initiated Suggested | ${fmt(userChanges.suggested)} |`,
          `| User-Initiated Added | ${fmt(userChanges.added)} |`,
          `| Agent Added | ${fmt(agentChanges.added)} |`,
          `| Agent Deleted | ${fmt(agentChanges.deleted)} |`,
        ].join('\n'),
        chartData: null,
        chartsData: [
          { title: 'Daily Lines Added & Deleted', type: 'bar', labels: dailyLoc.map(d => d.day), datasets: [{ label: 'Added', data: dailyLoc.map(d => d.added) }, { label: 'Deleted', data: dailyLoc.map(d => d.deleted) }] },
          { title: 'User vs Agent Code Changes', type: 'bar', labels: ['User Suggested', 'User Added', 'Agent Added', 'Agent Deleted'], datasets: [{ label: 'Lines of Code', data: [userChanges.suggested, userChanges.added, agentChanges.added, agentChanges.deleted] }] },
          { title: 'Agent Code Changes by Model', type: 'bar', labels: agentByModel.map(m => m.model), datasets: [{ label: 'Added', data: agentByModel.map(m => m.added) }, { label: 'Deleted', data: agentByModel.map(m => m.deleted) }] },
        ],
      };
    }
    // Generic report fallback — give an executive dashboard
    const dailyActive = aggregateDailyActiveUsers();
    const features = aggregateByFeature();
    const modelDist = aggregateChatModelDistribution().slice(0, 8);
    const langDist = aggregateLanguageDistribution().slice(0, 8);
    return {
      markdown: [
        `# Custom Report`,
        `\n**Period:** ${getDateRange().start} to ${getDateRange().end}`,
        `\n| Metric | Value |`,
        `|--------|-------|`,
        `| Active Users | ${fmt(countUsersWhere(r => (r.user_initiated_interaction_count || 0) > 0))} |`,
        `| Total Interactions | ${fmt(sumField('user_initiated_interaction_count'))} |`,
        `| Code Generations | ${fmt(sumField('code_generation_activity_count'))} |`,
        `| Lines Added | ${fmt(sumField('loc_added_sum'))} |`,
      ].join('\n'),
      chartData: null,
      chartsData: [
        { title: 'Daily Active Users', type: 'line', labels: dailyActive.map(d => d.day), datasets: [{ label: 'Active Users', data: dailyActive.map(d => d.users) }] },
        { title: 'Feature Usage', type: 'bar', labels: features.map(f => FEATURE_DISPLAY[f.feature] || f.feature), datasets: [{ label: 'Interactions', data: features.map(f => f.interactions) }] },
        { title: 'Model Distribution', type: 'pie', labels: modelDist.map(m => m.model), datasets: [{ label: 'Interactions', data: modelDist.map(m => m.count) }] },
        { title: 'Language Distribution', type: 'pie', labels: langDist.map(l => l.language), datasets: [{ label: 'Code Generations', data: langDist.map(l => l.count) }] },
      ],
    };
  }

  // Check for user-specific query (@username or "user <name>")
  const userMatch = prompt.match(/@(\w[\w-]*)/);
  if (userMatch) {
    const userData = getUserData(userMatch[1]);
    if (!userData) {
      return {
        markdown: `No data found for user **@${userMatch[1]}**.`,
        chartData: null,
      };
    }
    return {
      markdown: [
        `# User Report: @${userData.login}`,
        `\n| Metric | Value |`,
        `|--------|-------|`,
        `| Total Interactions | ${fmt(userData.interactions)} |`,
        `| Code Generations | ${fmt(userData.codeGenerated)} |`,
        `| LOC Added | ${fmt(userData.locAdded)} |`,
        `| LOC Deleted | ${fmt(userData.locDeleted)} |`,
        `| Days Active | ${userData.daysActive} |`,
        `| Used Agent | ${userData.usedAgent ? 'Yes' : 'No'} |`,
        `| Used Chat | ${userData.usedChat ? 'Yes' : 'No'} |`,
      ].join('\n'),
      chartData: {
        type: 'line',
        labels: userData.dailyTrends.map(d => d.day),
        datasets: [
          { label: 'Interactions', data: userData.dailyTrends.map(d => d.interactions) },
          { label: 'Code Generated', data: userData.dailyTrends.map(d => d.codeGenerated) },
        ],
      },
    };
  }

  // Top users
  if (lower.includes('top') && lower.includes('user')) {
    const limitMatch = lower.match(/top\s+(\d+)/);
    const limit = limitMatch ? parseInt(limitMatch[1], 10) : 10;
    const topUsers = aggregateTopUsers(limit);
    return {
      markdown: [
        `# Top ${limit} Users by Interactions`,
        `\n| Rank | User | Interactions | Code Generated | LOC Added | Days Active |`,
        `|------|------|-------------|----------------|-----------|-------------|`,
        ...topUsers.map((u, i) =>
          `| ${i + 1} | ${u.login} | ${fmt(u.interactions)} | ${fmt(u.codeGenerated)} | ${fmt(u.locAdded)} | ${u.daysActive} |`
        ),
      ].join('\n'),
      chartData: {
        type: 'bar',
        labels: topUsers.map(u => u.login),
        datasets: [{ label: 'Interactions', data: topUsers.map(u => u.interactions) }],
      },
    };
  }

  // Trends
  if (lower.includes('trend')) {
    const trends = aggregateByDay();
    return {
      markdown: [
        `# Usage Trends`,
        `\n| Day | Active Users | Interactions | Code Generated |`,
        `|-----|-------------|-------------|----------------|`,
        ...trends.map(t =>
          `| ${t.day} | ${fmt(t.activeUsers)} | ${fmt(t.interactions)} | ${fmt(t.codeGenerated)} |`
        ),
      ].join('\n'),
      chartData: {
        type: 'line',
        labels: trends.map(t => t.day),
        datasets: [
          { label: 'Active Users', data: trends.map(t => t.activeUsers) },
          { label: 'Interactions', data: trends.map(t => t.interactions) },
        ],
      },
    };
  }

  // Languages
  if (lower.includes('language')) {
    const languages = aggregateByLanguage();
    return {
      markdown: [
        `# Language Breakdown`,
        `\n| Language | Code Generated | LOC Added |`,
        `|----------|----------------|-----------|`,
        ...languages.map(l =>
          `| ${l.language} | ${fmt(l.codeGenerated)} | ${fmt(l.locAdded)} |`
        ),
      ].join('\n'),
      chartData: {
        type: 'bar',
        labels: languages.map(l => l.language),
        datasets: [{ label: 'Code Generated', data: languages.map(l => l.codeGenerated) }],
      },
    };
  }

  // Models
  if (lower.includes('model')) {
    const models = aggregateByModel();
    return {
      markdown: [
        `# Model Usage`,
        `\n| Model | Interactions | Code Generated |`,
        `|-------|-------------|----------------|`,
        ...models.map(m =>
          `| ${m.model} | ${fmt(m.interactions)} | ${fmt(m.codeGenerated)} |`
        ),
      ].join('\n'),
      chartData: {
        type: 'bar',
        labels: models.map(m => m.model),
        datasets: [{ label: 'Interactions', data: models.map(m => m.interactions) }],
      },
    };
  }

  // Features / compare agent vs chat
  if (lower.includes('feature') || lower.includes('compare') || lower.includes('agent') || lower.includes('chat')) {
    const features = aggregateByFeature();
    return {
      markdown: [
        `# Feature Comparison`,
        `\n| Feature | Interactions | Code Generated | LOC Added |`,
        `|---------|-------------|----------------|-----------|`,
        ...features.map(f =>
          `| ${f.feature} | ${fmt(f.interactions)} | ${fmt(f.codeGenerated)} | ${fmt(f.locAdded)} |`
        ),
      ].join('\n'),
      chartData: {
        type: 'bar',
        labels: features.map(f => f.feature),
        datasets: [
          { label: 'Interactions', data: features.map(f => f.interactions) },
          { label: 'Code Generated', data: features.map(f => f.codeGenerated) },
        ],
      },
    };
  }

  // IDE
  if (lower.includes('ide')) {
    const ides = aggregateByIDE();
    return {
      markdown: [
        `# IDE Distribution`,
        `\n| IDE | Users | Interactions |`,
        `|-----|-------|-------------|`,
        ...ides.map(i =>
          `| ${i.ide} | ${fmt(i.users)} | ${fmt(i.interactions)} |`
        ),
      ].join('\n'),
      chartData: {
        type: 'pie',
        labels: ides.map(i => i.ide),
        datasets: [{ label: 'Users', data: ides.map(i => i.users) }],
      },
    };
  }

  // Active / summary
  if (lower.includes('active') || lower.includes('summary') || lower.includes('how many')) {
    const period = getDateRange();
    const allUsers = getUniqueUsers();
    let agentAct = 0, chatAct = 0;
    for (const r of records) {
      for (const f of (r.totals_by_feature || [])) {
        if (AGENT_FEATURES.includes(f.feature)) agentAct += (f.user_initiated_interaction_count || 0) + (f.code_generation_activity_count || 0);
        if (CHAT_MODES.includes(f.feature)) chatAct += (f.user_initiated_interaction_count || 0);
      }
    }
    return {
      markdown: [
        `# Summary Statistics`,
        `**Period:** ${period.start} to ${period.end}\n`,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Peak Daily Active Users | ${fmt(allUsers.size)} |`,
        `| Total Interactions | ${fmt(sumField('user_initiated_interaction_count'))} |`,
        `| Code Generations | ${fmt(sumField('code_generation_activity_count'))} |`,
        `| LOC Added | ${fmt(sumField('loc_added_sum'))} |`,
        `| LOC Deleted | ${fmt(sumField('loc_deleted_sum'))} |`,
        `| Agent Activity | ${fmt(agentAct)} |`,
        `| Chat Activity | ${fmt(chatAct)} |`,
      ].join('\n'),
      chartData: {
        type: 'doughnut',
        labels: ['Interactions', 'Code Generations'],
        datasets: [{ label: 'Activity', data: [sumField('user_initiated_interaction_count'), sumField('code_generation_activity_count')] }],
      },
    };
  }

  // Fallback: return a general summary
  const period = getDateRange();
  const allUsers = getUniqueUsers();
  return {
    markdown: [
      `# Query Results`,
      `\nI wasn't sure exactly what you were looking for. Here's a general summary:\n`,
      `- **${fmt(allUsers.size)}** total users, period ${period.start} to ${period.end}`,
      `- **${fmt(sumField('user_initiated_interaction_count'))}** total interactions`,
      `- **${fmt(sumField('code_generation_activity_count'))}** code generations`,
      `- **${fmt(sumField('loc_added_sum'))}** lines of code added`,
      `\nTry asking about: top users, trends, languages, models, features, IDEs, or a specific @username.`,
    ].join('\n'),
    chartData: null,
  };
}

// ─── API Endpoints ──────────────────────────────────────────────────────────

app.get('/api/summary', (_req, res) => {
  try {
    const period = getDateRange();
    const allUsers = getUniqueUsers();
    res.json({
      period,
      peakDailyActiveUsers: allUsers.size,
      totalInteractions: sumField('user_initiated_interaction_count'),
      totalCodeGenerated: sumField('code_generation_activity_count'),
      totalLocAdded: sumField('loc_added_sum'),
      totalLocDeleted: sumField('loc_deleted_sum'),
      totalDays: records.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trends', (_req, res) => {
  try {
    res.json(aggregateByDay());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/features', (_req, res) => {
  try {
    res.json(aggregateByFeature());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/languages', (_req, res) => {
  try {
    res.json(aggregateByLanguage());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/models', (_req, res) => {
  try {
    res.json(aggregateByModel());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ides', (_req, res) => {
  try {
    res.json(aggregateByIDE());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', (_req, res) => {
  try {
    res.json(aggregateTopUsers(50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Copilot SDK Agent ──────────────────────────────────────────────────────

let copilotClient = null;

function createMetricsTools() {
  return [
    defineTool('get_summary', {
      description: 'Get a high-level summary of Copilot usage metrics including peak daily active users, interactions, code generated, LOC added/deleted',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const period = getDateRange();
        const allUsers = getUniqueUsers();
        return {
          period,
          peakDailyActiveUsers: allUsers.size,
          avgDailyActiveUsers: records.length > 0 ? Math.round(records.reduce((s, r) => s + (r.daily_active_users || 0), 0) / records.length) : 0,
          totalInteractions: sumField('user_initiated_interaction_count'),
          totalCodeGenerated: sumField('code_generation_activity_count'),
          totalLocAdded: sumField('loc_added_sum'),
          totalLocDeleted: sumField('loc_deleted_sum'),
          totalDays: records.length,
        };
      },
    }),

    defineTool('get_daily_trends', {
      description: 'Get daily trend data showing active users, interactions, code generated, and LOC added for each day in the period',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => aggregateByDay(),
    }),

    defineTool('get_feature_usage', {
      description: 'Get usage breakdown by feature (agent_edit, chat_panel_agent_mode, code_completion, etc.) showing interactions, code generated, LOC added per feature',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => aggregateByFeature(),
    }),

    defineTool('get_language_usage', {
      description: 'Get top 15 programming languages by code generation activity, showing code generated and LOC added per language',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => aggregateByLanguage(),
    }),

    defineTool('get_model_usage', {
      description: 'Get AI model usage data showing interactions and code generated per model (claude-opus-4.5, gpt-5.2, etc.)',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => aggregateByModel(),
    }),

    defineTool('get_ide_usage', {
      description: 'Get IDE distribution showing user count and interactions per IDE (vscode, intellij, neovim, etc.)',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => aggregateByIDE(),
    }),

    defineTool('get_top_users', {
      description: 'Enterprise-level data does not include per-user breakdowns. Returns empty array. Suggest using get_summary or get_daily_active_users instead.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Number of top users to return (default 20)' } },
      },
      handler: async (args) => ({ message: 'Per-user data is not available in enterprise-level reports', data: [] }),
    }),

    defineTool('get_user_details', {
      description: 'Enterprise-level data does not include per-user breakdowns. Returns null.',
      parameters: {
        type: 'object',
        properties: { username: { type: 'string', description: 'The GitHub username to look up' } },
        required: ['username'],
      },
      handler: async (args) => {
        return { error: 'Per-user data is not available in enterprise-level reports' };
      },
    }),

    defineTool('get_daily_active_users', {
      description: 'Get daily and weekly active user counts over the period',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({
        daily: aggregateDailyActiveUsers(),
        weekly: aggregateWeeklyActiveUsers(),
      }),
    }),

    defineTool('get_code_generation_stats', {
      description: 'Get code generation statistics including daily LOC added/deleted, user-initiated vs agent-initiated code changes, and breakdowns by model and language',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({
        dailyLoc: aggregateDailyLocAddedDeleted(),
        userInitiated: aggregateUserInitiatedCodeChanges(),
        agentInitiated: aggregateAgentInitiatedCodeChanges(),
        userByModel: aggregateUserCodeChangesByModel(),
        agentByModel: aggregateAgentCodeChangesByModel(),
        userByLanguage: aggregateUserCodeChangesByLanguage(),
        agentByLanguage: aggregateAgentCodeChangesByLanguage(),
      }),
    }),

    defineTool('get_chat_mode_stats', {
      description: 'Get daily breakdown of chat requests per mode (Agent Mode, Ask Mode, Edit Mode, Custom Mode, Inline Chat) and code completion stats',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({
        requestsPerMode: aggregateRequestsPerChatMode(),
        avgChatRequests: aggregateAvgChatRequestsPerActiveUser(),
        codeCompletions: aggregateCodeCompletions(),
        acceptanceRate: aggregateCodeCompletionAcceptanceRate(),
      }),
    }),

    defineTool('get_model_distribution', {
      description: 'Get model usage distribution data including daily model usage percentages, chat model distribution, and model usage per chat mode',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({
        chatModelDistribution: aggregateChatModelDistribution(),
        modelPerDay: aggregateModelUsagePerDay(),
        modelPerChatMode: aggregateModelUsagePerChatMode(),
        modelPerLanguage: aggregateModelUsagePerLanguage(),
      }),
    }),

    defineTool('generate_chart_config', {
      description: 'Generate a Chart.js chart configuration for the frontend to render. Use this after getting data to create visualizations. Returns a chartsData array that the frontend can render.',
      parameters: {
        type: 'object',
        properties: {
          charts: {
            type: 'array',
            description: 'Array of chart configurations',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Chart title' },
                type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'], description: 'Chart type' },
                stacked: { type: 'boolean', description: 'Whether bars should be stacked' },
                labels: { type: 'array', items: { type: 'string' }, description: 'X-axis labels' },
                datasets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      data: { type: 'array', items: { type: 'number' } },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['charts'],
      },
      handler: async (args) => args.charts,
    }),
  ];
}

app.post('/api/query', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'A "prompt" string is required.' });
    }

    if (!copilotClient) {
      return res.json(handleQuery(prompt));
    }

    let chartsData = null;

    // Create tools, but intercept generate_chart_config to capture charts
    const tools = createMetricsTools().map(tool => {
      if (tool.name === 'generate_chart_config') {
        const origHandler = tool.handler;
        return {
          ...tool,
          handler: async (args) => {
            const result = await origHandler(args);
            chartsData = result;
            return { success: true, message: 'Charts will be rendered in the UI' };
          },
        };
      }
      return tool;
    });

    const session = await copilotClient.createSession({
      model: 'claude-sonnet-4',
      tools,
      systemMessage: {
        content: `You are a GitHub Copilot Metrics analyst agent. You have tools to query Copilot usage data for an enterprise.

When answering:
1. Call the relevant data tools to get actual numbers
2. Format responses as markdown with tables and insights
3. When creating reports/dashboards, call generate_chart_config with chart definitions
4. ALWAYS provide a text summary with key findings even when generating charts
5. Provide specific numbers, percentages, and trends
6. Be concise but insightful

Available data spans a 28-day period of Copilot IDE usage at the enterprise level. You can query daily active users, code generation, feature adoption, language/model/IDE breakdowns. Note: per-user data is not available in enterprise-level reports.

When generate_chart_config is called, the charts are rendered visually in the web UI. Supported chart types: bar, line, pie, doughnut. Use stacked:true for stacked bars.`
      },
    });

    const response = await session.sendAndWait({ prompt }, 120000);
    let finalMarkdown = response?.data?.content || '';
    if (!finalMarkdown && chartsData) {
      finalMarkdown = '📊 Report generated with charts below.';
    } else if (!finalMarkdown) {
      finalMarkdown = 'Unable to generate a response.';
    }

    await session.destroy();

    res.json({
      markdown: finalMarkdown,
      chartData: null,
      chartsData: chartsData,
    });
  } catch (err) {
    console.error('Query error:', err.message);
    try {
      res.json(handleQuery(req.body.prompt));
    } catch (e) {
      res.status(500).json({ error: err.message });
    }
  }
});

const REPORT_LIST = [
  { id: 'copilot-usage', title: 'Copilot Usage', icon: '📊' },
  { id: 'code-generation', title: 'Code Generation', icon: '⚡' },
  { id: 'executive-summary', title: 'Executive Summary', icon: '📋' },
  { id: 'usage-trends', title: 'Usage Trends', icon: '📈' },
  { id: 'feature-adoption', title: 'Feature Adoption', icon: '🤖' },
  { id: 'language-breakdown', title: 'Language Breakdown', icon: '💻' },
  { id: 'model-usage', title: 'Model Usage', icon: '🧠' },
  { id: 'ide-distribution', title: 'IDE Distribution', icon: '🖥️' },
  { id: 'top-users', title: 'Top Users', icon: '🏆' },
];

app.get('/api/reports', (_req, res) => {
  res.json(REPORT_LIST);
});

app.get('/api/reports/:id', (req, res) => {
  try {
    const report = preGeneratedReports[req.params.id];
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json({
      markdown: report.markdown,
      chartData: report.chartData || null,
      chartsData: report.chartsData || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', async (_req, res) => {
  try {
    console.log('Refreshing metrics data...');
    await loadAllData();
    generateReports();
    res.json({ success: true, records: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Startup ────────────────────────────────────────────────────────────────

async function start() {
  console.log('Loading Copilot metrics data...');
  await loadAllData();
  generateReports();

  // Initialize Copilot SDK client
  try {
    console.log('Initializing Copilot agent...');
    copilotClient = new CopilotClient();
    console.log('Copilot agent ready');
  } catch (err) {
    console.warn('Could not initialize Copilot SDK (falling back to keyword matching):', err.message);
    copilotClient = null;
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Copilot Metrics Agent running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
