import { Client, GatewayIntentBits, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { cleanupMediaFiles, extractImageAttachments, saveImageAttachments } from './media.js';
import { moderatePost, rejectionReasons } from './moderation.js';
import { enqueuePost, peekPost, readQueue, removePost, removePostAtPosition } from './queue.js';
import { getReportStats, markReported, recordSuccessfulPost } from './stats.js';
import { closeXBrowser, ensureXBrowserReady, postToX, likeToX, retweetToX } from './xPoster.js';
import { savePostLog, getPostUrl } from './postLog.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let posting = false;
let nextTimer = null;
let nextPostTargetTime = Date.now();
let dailyReportTimer = null;

const queueDeleteCommand = new SlashCommandBuilder()
  .setName('delete')
  .setDescription('キュー内の投稿をリスト番号で削除します')
  .addIntegerOption((option) => option
    .setName('index')
    .setDescription('削除するリスト番号')
    .setMinValue(1)
    .setRequired(true));

const likeCommand = new SlashCommandBuilder()
  .setName('like')
  .setDescription('ポストに「いいね」をします')
  .addIntegerOption((option) => option
    .setName('post_no')
    .setDescription('対象の通し番号（#なしの数字）')
    .setMinValue(1)
    .setRequired(false))
  .addStringOption((option) => option
    .setName('url')
    .setDescription('XポストのURL（post_no の代わりに直接指定）')
    .setRequired(false));

const retweetCommand = new SlashCommandBuilder()
  .setName('retweet')
  .setDescription('ポストをリポスト（リツイート）します')
  .addIntegerOption((option) => option
    .setName('post_no')
    .setDescription('対象の通し番号（#なしの数字）')
    .setMinValue(1)
    .setRequired(false))
  .addStringOption((option) => option
    .setName('url')
    .setDescription('XポストのURL（post_no の代わりに直接指定）')
    .setRequired(false));

function extractPostText(message) {
  return message.content.trim();
}

function extractXUrl(text = '') {
  const match = text.match(/https?:\/\/(?:x\.com|twitter\.com)\/[^\s)]+/i);
  return match?.[0] || null;
}

async function resolveQuoteUrl(message) {
  if (!message.reference?.messageId) return null;
  try {
    const referenced = await message.fetchReference();
    const contentUrl = extractXUrl(referenced.content);
    if (contentUrl) return contentUrl;

    for (const embed of referenced.embeds) {
      const embedUrl = extractXUrl([
        embed.url,
        embed.title,
        embed.description
      ].filter(Boolean).join('\n'));
      if (embedUrl) return embedUrl;
    }

    const postNoMatch = referenced.content.match(/#(\d+)/);
    if (!postNoMatch) return null;

    return await getPostUrl(Number(postNoMatch[1]));
  } catch (error) {
    console.error('Quote lookup failed:', error);
    return null;
  }
}

function nextDelayMs() {
  const base = config.postIntervalMinutes;
  const jitter = config.postIntervalJitterMinutes;
  const minutes = base + (Math.random() * jitter * 2 - jitter);
  return Math.max(1, minutes) * 60_000;
}

function estimatePostTime(position) {
  const baseTime = nextPostTargetTime;
  const additionalTime = Math.max(0, position - 1) * config.postIntervalMinutes * 60_000;
  return new Date(baseTime + additionalTime);
}

async function scheduleNextPost(delay = nextDelayMs()) {
  if (nextTimer) clearTimeout(nextTimer);

  nextPostTargetTime = Date.now() + delay;

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
      const url = await postToX(item.text, item.mediaPaths || []);

      if (item.postNo && url) {
        await savePostLog(item.postNo, url, item.authorId, item.text);
      }

      await recordSuccessfulPost(item.authorId);

      await removePost(item.id);
      await cleanupMediaFiles(item.mediaPaths);

      try {
        await sendPostLog(item, url);
      } catch (error) {
        console.error('Post log failed:', error);
      }

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

function getLogChannels() {
  return client.guilds.cache
    .map((guild) => guild.channels.cache.find((channel) => (
      channel.name === config.logChannelName && channel.isTextBased()
    )))
    .filter(Boolean);
}

async function sendPostLog(item, url) {
  const time = new Date().toLocaleString('ja-JP');

  for (const channel of getLogChannels()) {
    await channel.send(
`📤 投稿完了

No:#${item.postNo}

投稿者:
<@${item.authorId}>

投稿日時:
${time}

URL:
${url || '取得失敗'}

本文:
${item.text}`
    ).catch((err) => console.error(`ログチャンネルへの送信失敗:`, err));
  }
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

async function registerGuildCommands() {
  await Promise.all(client.guilds.cache.map((guild) => guild.commands.set([
    queueDeleteCommand.toJSON(),
    likeCommand.toJSON(),
    retweetCommand.toJSON()
  ])));
}

client.once('ready', async () => {
  const queue = await readQueue();
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Queue length: ${queue.length}`);
  await registerGuildCommands();
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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // --- delete コマンド ---
  if (interaction.commandName === 'delete') {
    const position = interaction.options.getInteger('index', true);
    try {
      const { item, queueLength } = await removePostAtPosition(position);
      if (!item) {
        await interaction.reply({
          content: `リスト${position}番目の投稿はありません。現在のリスト数は${queueLength}件です`,
          ephemeral: true
        });
        return;
      }

      await cleanupMediaFiles(item.mediaPaths);
      await interaction.reply({
        content: `リスト${position}番目の投稿を削除しました。残り${queueLength}件です`,
        ephemeral: true
      });
    } catch (error) {
      console.error('Queue delete command failed:', error);
      await interaction.reply({
        content: '削除処理に失敗しました。ログを確認してください',
        ephemeral: true
      });
    }
    return;
  }

  // --- like / retweet コマンド ---
  if (interaction.commandName === 'like' || interaction.commandName === 'retweet') {
    await interaction.deferReply({ ephemeral: true });

    const isLike = interaction.commandName === 'like';
    const postNo = interaction.options.getInteger('post_no');
    const directUrl = interaction.options.getString('url');

    // post_no と url のどちらも未指定はエラー
    if (!postNo && !directUrl) {
      await interaction.editReply('`post_no` か `url` のどちらかを指定してください。');
      return;
    }

    try {
      let url = directUrl;

      if (!url) {
        url = await getPostUrl(postNo);
        if (!url) {
          await interaction.editReply(`通し番号 #${postNo} のポストURLが保存されていません。`);
          return;
        }
      }

      if (isLike) {
        await likeToX(url);
        await interaction.editReply(`「いいね」をしました！\n${url}`);
      } else {
        await retweetToX(url);
        await interaction.editReply(`リポストしました！\n${url}`);
      }
    } catch (error) {
      console.error(`${interaction.commandName} command failed:`, error);
      await interaction.editReply(`${isLike ? 'いいね' : 'リポスト'}処理に失敗しました。ブラウザ側のログを確認してください。`);
    }
    return;
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const channelName = message.channel?.name;
  const text = extractPostText(message);
  const imageAttachments = extractImageAttachments(message);
  if (!text && imageAttachments.length === 0) return;

  // 即時投稿チャンネル
  if (channelName === config.unrestrictedChannelName) {
    let mediaPaths = [];
    try {
      mediaPaths = await saveImageAttachments(message);

      // 返信なら引用URLを末尾に付加
      const quotedUrl = await resolveQuoteUrl(message);
      const finalText = quotedUrl ? `${text}\n\n${quotedUrl}` : text;

      await message.reply('即時投稿します');

      const url = await postToX(finalText, mediaPaths);
      await recordSuccessfulPost(message.author.id);
      await message.reply('投稿しました');

      try {
        await sendPostLog({
          postNo: '即時',
          authorId: message.author.id,
          text: finalText
        }, url);
      } catch (logError) {
        console.error('Immediate post log failed:', logError);
      }

    } catch (error) {
      console.error('Immediate post failed:', error);
      await message.reply('投稿に失敗しました。ログを確認してください');
    } finally {
      await cleanupMediaFiles(mediaPaths);
    }
    return;
  }

  // 通常投稿（モデレーション付きキュー）チャンネル
  if (channelName === config.moderatedChannelName) {
    try {
      // 返信なら引用URLを末尾に付加
      const quotedUrl = await resolveQuoteUrl(message);
      const finalText = quotedUrl ? `${text}\n\n${quotedUrl}` : text;

      const code = finalText ? await moderatePost(finalText) : 0;
      if (code === 0) {
        const mediaPaths = await saveImageAttachments(message);

        const { position, item } = await enqueuePost(finalText, message.author.id, mediaPaths);
        const postTime = estimatePostTime(position);
        await message.reply(`受付 #${item.postNo}\n予定投稿: ${postTime.toLocaleString('ja-JP')}`);

        for (const logChannel of getLogChannels()) {
          await logChannel.send(
`📥 投稿受付

No:#${item.postNo}

投稿者:
<@${message.author.id}>

予定投稿:
${postTime.toLocaleString('ja-JP')}

本文:
${finalText}`
          ).catch((err) => console.error(`受付ログ送信失敗:`, err));
        }
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
