import { readFileSync, writeFileSync, existsSync } from "fs";
import { DB_PATH, FEED_PATH } from "./config.js";

// Simple JSON-based tracker (no SQLite dependency = easier install on Windows)
const TRACKER_PATH = DB_PATH.replace(".db", ".json");

function loadTracker() {
  if (existsSync(TRACKER_PATH)) {
    return JSON.parse(readFileSync(TRACKER_PATH, "utf-8"));
  }
  return { opportunities: {}, lastRun: {}, runHistory: [] };
}

function saveTracker(data) {
  writeFileSync(TRACKER_PATH, JSON.stringify(data, null, 2));
}

export function getTrackedOpportunities() {
  return loadTracker().opportunities;
}

export function upsertOpportunity(opp) {
  const tracker = loadTracker();
  const id = opp.id || opp.noticeId || `${opp.platform}-${opp.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80);
  const existing = tracker.opportunities[id];

  tracker.opportunities[id] = {
    ...existing,
    ...opp,
    id,
    updatedAt: new Date().toISOString(),
    foundDate: existing?.foundDate || new Date().toISOString(),
  };

  saveTracker(tracker);
  return { isNew: !existing, id };
}

export function recordRun(platform, results) {
  const tracker = loadTracker();
  tracker.lastRun[platform] = {
    timestamp: new Date().toISOString(),
    found: results.length,
    newCount: results.filter((r) => r.isNew).length,
  };
  tracker.runHistory.push({
    platform,
    timestamp: new Date().toISOString(),
    found: results.length,
    newCount: results.filter((r) => r.isNew).length,
  });
  // Keep last 500 run history entries
  if (tracker.runHistory.length > 500) {
    tracker.runHistory = tracker.runHistory.slice(-500);
  }
  saveTracker(tracker);
}

export function exportFeed() {
  const tracker = loadTracker();
  const opportunities = Object.values(tracker.opportunities)
    .sort((a, b) => {
      // Sort by relevance score desc, then deadline asc
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      if (a.deadline && b.deadline) return new Date(a.deadline) - new Date(b.deadline);
      return 0;
    });

  const feed = {
    last_updated: new Date().toISOString(),
    total: opportunities.length,
    opportunities,
    monitor_status: Object.entries(tracker.lastRun).map(([platform, info]) => ({
      platform,
      ...info,
    })),
  };

  writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));
  return feed;
}

export function getRunHistory(platform) {
  const tracker = loadTracker();
  if (platform) {
    return tracker.runHistory.filter((r) => r.platform === platform);
  }
  return tracker.runHistory;
}

export function dismissOpportunity(id) {
  const tracker = loadTracker();
  if (tracker.opportunities[id]) {
    tracker.opportunities[id].status = "dismissed";
    tracker.opportunities[id].updatedAt = new Date().toISOString();
    saveTracker(tracker);
    return true;
  }
  return false;
}
