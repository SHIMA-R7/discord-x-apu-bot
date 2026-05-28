import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve('data');
const statsFile = path.join(dataDir, 'stats.json');

function getDayKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

function defaultStats() {
  return {
    dayKey: getDayKey(),
    dailyPosted: 0,
    totalPosted: 0,
    activeUserIds: [],
    lastReportDayKey: null
  };
}

async function ensureStatsFile() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(statsFile);
  } catch {
    await fs.writeFile(statsFile, `${JSON.stringify(defaultStats(), null, 2)}\n`, 'utf8');
  }
}

async function writeStats(stats) {
  await ensureStatsFile();
  await fs.writeFile(statsFile, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
}

export async function readStats() {
  await ensureStatsFile();
  const raw = await fs.readFile(statsFile, 'utf8');
  const stats = { ...defaultStats(), ...JSON.parse(raw) };
  if (!Array.isArray(stats.activeUserIds)) {
    stats.activeUserIds = [];
  }
  return stats;
}

async function rolloverIfNeeded(stats) {
  const today = getDayKey();
  if (stats.dayKey === today) return stats;

  return {
    ...stats,
    dayKey: today,
    dailyPosted: 0,
    activeUserIds: []
  };
}

export async function recordSuccessfulPost(authorId) {
  const stats = await rolloverIfNeeded(await readStats());
  stats.dailyPosted += 1;
  stats.totalPosted += 1;

  if (authorId && !stats.activeUserIds.includes(authorId)) {
    stats.activeUserIds.push(authorId);
  }

  await writeStats(stats);
  return stats;
}

export async function getReportStats() {
  const stats = await rolloverIfNeeded(await readStats());
  await writeStats(stats);
  return {
    dayKey: stats.dayKey,
    dailyPosted: stats.dailyPosted,
    totalPosted: stats.totalPosted,
    activeMembers: stats.activeUserIds.length,
    lastReportDayKey: stats.lastReportDayKey
  };
}

export async function markReported(dayKey) {
  const stats = await readStats();
  stats.lastReportDayKey = dayKey;
  await writeStats(stats);
}
