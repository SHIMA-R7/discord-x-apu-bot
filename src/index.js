import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { cleanupMediaFiles, extractImageAttachments, saveImageAttachments } from './media.js';
import { moderatePost, rejectionReasons } from './moderation.js';
import { enqueuePost, peekPost, readQueue, removePost } from './queue.js';
import { getReportStats, markReported, recordSuccessfulPost } from './stats.js';
import { closeXBrowser, ensureXBrowserReady, postToX } from './xPoster.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let posting = false;
let nextTimer = null;
let dailyReportTimer = null;

function extractPostText(message) {
  return message.content.trim();
}

function nextDelayMs() {
  const base = config.postIntervalMinutes;
  const jitter = config.postIntervalJitterMinutes;
  const minutes = base + (Math.random() * jitter * 2 - jitter);
  return Math.max(1, minutes) * 60_000;
}

function estimateMinutes(position) {
  return Math.max(0, Math.round(position * config.postIntervalMinutes));
}

async function scheduleNextPost(delay = nextDelayMs()) {
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = setTimeout(runQueueWorker, delay);
}

async function runQueueWorker() {
  if (posting) {
    await scheduleNextPost(30_000);
    return;
  }

  posting = true;
  try {
    const item = await peekPost();
    if (item) {
      await postToX(item.text, item.mediaPaths || []);
      await recordSuccessfulPost(item.authorId);
      await removePost(item.id);
      await cleanupMediaFiles(item.mediaPaths);
      console.log(`Posted queued item ${item.id}`);
    }
  } catch (error) {
    console.error('Queue worker failed:', error);
  } finally {
    posting = false;
    await scheduleNextPost();
  }
}

function getTodayKey() {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
}

function getNextReportDelayMs() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(config.dailyReportHour, config.dailyReportMinute, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

function buildDailyReport({ totalMembers, activeMembers, dailyPosted, totalPosted }) {
  return [
    'APU 日次レポート',
    `総メンバー数: ${totalMembers}`,
    `アクティブメンバー数: ${activeMembers}`,
    `本日の投稿件数: ${dailyPosted}`,
    `累計投稿件数: ${totalPosted}`
  ].join('\n');
}

function getSystemChannels() {
  return client.guilds.cache
    .map((guild) => guild.channels.cache.find((channel) => (
      channel.name === config.systemChannelName && channel.isTextBased()
    )))
    .filter(Boolean);
}

function getTotalMemberCount() {
  return client.guilds.cache.reduce((sum, guild) => sum + (guild.memberCount || 0), 0);
}

async function sendDailyReport() {
  const stats = await getReportStats();
  const today = getTodayKey();

  if (stats.lastReportDayKey === today) {
    return;
  }

  const report = buildDailyReport({
    totalMembers: getTotalMemberCount(),
    activeMembers: stats.activeMembers,
    dailyPosted: stats.dailyPosted,
    totalPosted: stats.totalPosted
  });

  for (const channel of getSystemChannels()) {
    await channel.send(report);
  }

  await postToX(report);
  await markReported(today);
  console.log(`Sent daily report for ${today}`);
}

async function scheduleDailyReport() {
  if (dailyReportTimer) clearTimeout(dailyReportTimer);
  dailyReportTimer = setTimeout(async () => {
    try {
      await sendDailyReport();
    } catch (error) {
      console.error('Daily report failed:', error);
    } finally {
      await scheduleDailyReport();
    }
  }, getNextReportDelayMs());
}

client.once('ready', async () => {
  const queue = await readQueue();
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Queue length: ${queue.length}`);
  await ensureXBrowserReady();
  await scheduleNextPost();
  await scheduleDailyReport();
});

async function shutdown() {
  await closeXBrowser();
  client.destroy();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const channelName = message.channel?.name;
  const text = extractPostText(message);
  const imageAttachments = extractImageAttachments(message);
  if (!text && imageAttachments.length === 0) return;

  if (channelName === config.unrestrictedChannelName) {
    let mediaPaths = [];
    try {
      mediaPaths = await saveImageAttachments(message);
      await message.reply('即時投稿します');
      await postToX(text, mediaPaths);
      await recordSuccessfulPost(message.author.id);
      await message.reply('投稿しました');
    } catch (error) {
      console.error('Immediate post failed:', error);
      await message.reply('投稿に失敗しました。ログを確認してください');
    } finally {
      await cleanupMediaFiles(mediaPaths);
    }
    return;
  }

  if (channelName === config.moderatedChannelName) {
    try {
      const code = text ? await moderatePost(text) : 0;
      if (code === 0) {
        const mediaPaths = await saveImageAttachments(message);
        const { position } = await enqueuePost(text, message.author.id, mediaPaths);
        await message.reply(`リスト${position}番目、約${estimateMinutes(position)}分後に投稿されます`);
      } else {
        const reason = rejectionReasons[code] || rejectionReasons[6];
        await message.reply(`${reason}為、本投稿は阻止されました`);
      }
    } catch (error) {
      console.error('Moderation failed:', error);
      await message.reply('判定処理に失敗しました。ログを確認してください');
    }
  }
});

await client.login(config.discordToken);
