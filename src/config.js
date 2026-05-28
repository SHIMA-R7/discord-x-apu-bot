import dotenv from 'dotenv';

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return value;
}

function integerRangeEnv(name, fallback, min, max) {
  const value = numberEnv(name, fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid integer environment variable: ${name}`);
  }
  return value;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite-preview-09-2025',
  unrestrictedChannelName: process.env.UNRESTRICTED_CHANNEL_NAME || '制限なし投稿',
  moderatedChannelName: process.env.MODERATED_CHANNEL_NAME || '投稿',
  systemChannelName: process.env.SYSTEM_CHANNEL_NAME || 'システム',
  xBrowserChannel: process.env.X_BROWSER_CHANNEL || 'chrome',
  xProfileDir: process.env.X_PROFILE_DIR || '.x-profile-apu',
  postIntervalMinutes: numberEnv('POST_INTERVAL_MINUTES', 10),
  postIntervalJitterMinutes: numberEnv('POST_INTERVAL_JITTER_MINUTES', 1),
  dailyReportHour: integerRangeEnv('DAILY_REPORT_HOUR', 23, 0, 23),
  dailyReportMinute: integerRangeEnv('DAILY_REPORT_MINUTE', 59, 0, 59)
};
