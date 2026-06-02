import { Client, GatewayIntentBits, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { cleanupMediaFiles, extractImageAttachments, saveImageAttachments } from './media.js';
import { moderatePost, rejectionReasons } from './moderation.js';
import { enqueuePost, peekPost, readQueue, removePost, removePostAtPosition, resolvePendingQuote } from './queue.js';
import { getReportStats, markReported, recordSuccessfulPost } from './stats.js';
import { closeXBrowser, ensureXBrowserReady, postToX, likeToX, retweetToX, replyToX, getXPageHandle } from './xPoster.js';
import { startMentionNotifier, stopMentionNotifier } from './xNotifier.js';
import { savePostLog, getPostUrl, getPostUrlByMessageId } from './postLog.js';

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

async function fetchReferencedMessage(message) {
  if (!message.reference?.messageId) return null;

  try {
    return await message.fetchReference();
  } catch {}

  try {
    const channel = await client.channels.fetch(message.reference.channelId);
    if (!channel?.messages) return null;
    return await channel.messages.fetch(message.reference.messageId);
  } catch (error) {
    console.error('fetchReferencedMessage failed:', error);
    return null;
  }
}

// 返信元メッセージからXポストURLを解決する。
// 戻り値: { url: string|null, pendingMessageId: string|null }
//   url が取れた → 即時付加
//   pendingMessageId が返る → まだ未投稿なので待機が必要
async function resolveQuoteUrl(message) {
  if (!message.reference?.messageId) return { url: null, pendingMessageId: null };

  console.log(`Discord reply detected: ${message.id} -> ${message.reference.messageId}`);

  const referenced = await fetchReferencedMessage(message);
  if (!referenced) return { url: null, pendingMessageId: null };

  // ① byMessageId 逆引き（投稿済みなら即ヒット）
  const byMsgUrl = await getPostUrlByMessageId(referenced.id);
  if (byMsgUrl) return { url: byMsgUrl, pendingMessageId: null };

  // ② 返信元本文に X の URL が直書きされている
  const contentUrl = extractXUrl(referenced.content);
  if (contentUrl) return { url: contentUrl, pendingMessageId: null };

  // ③ embed 内の URL
  for (const embed of referenced.embeds) {
    const embedUrl = extractXUrl([embed.url, embed.title, embed.description].filter(Boolean).join('\n'));
    if (embedUrl) return { url: embedUrl, pendingMessageId: null };
  }

  // ④ #数字 → postLog 逆引き
  const postNoMatch = referenced.content.match(/#(\d+)/);
  if (postNoMatch) {
    const postUrl = await getPostUrl(Number(postNoMatch[1]));
    if (postUrl) return { url: postUrl, pendingMessageId: null };
  }

  // ⑤ 返信元がキュー内に存在する → 未投稿なので待機が必要
  const queue = await readQueue();
  const queuedItem = queue.find((q) => q.sourceMessageId === referenced.id);
  if (queuedItem) {
    console.log(`Referenced message ${referenced.id} is queued as #${queuedItem.postNo}, will wait for URL`);
    return { url: null, pendingMessageId: referenced.id };
  }

  return { url: null, pendingMessageId: null };
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
      // pendingQuoteMessageId がある → 返信元の投稿URLを待機中
      if (item.pendingQuoteMessageId) {
        const resolvedUrl = await getPostUrlByMessageId(item.pendingQuoteMessageId);
        if (!resolvedUrl) {
          // まだ未投稿。スキップして次のスケジュールへ
          console.log(`Skipping #${item.postNo}: waiting for quote URL of message ${item.pendingQuoteMessageId}`);
          posting = false;
          await scheduleNextPost();
          return;
        }
        // URL が確定したので text に付加して pending を解除
        const updatedText = `${item.text}\n\n${resolvedUrl}`;
        await resolvePendingQuote(item.id, updatedText);
        item.text = updatedText;
        item.pendingQuoteMessageId = null;
        console.log(`Resolved pending quote for #${item.postNo}: ${resolvedUrl}`);
      }

      const url = await postToX(item.text, item.mediaPaths || []);

      if (item.postNo && url) {
        await savePostLog(item.postNo, url, item.authorId, item.text, {
          sourceMessageId: item.sourceMessageId,
          sourceChannelId: item.sourceChannelId,
          sourceGuildId: item.sourceGuildId
        });
      }

      await recordSuccessfulPost(item.authorId);

      // 元のDiscordメッセージに「投稿しました URL」と返信
      // → ユーザーがその発言に返信したとき resolveQuoteUrl が URL を逆引きできる
      if (item.sourceMessageId && item.sourceChannelId) {
        try {
          const sourceChannel = await client.channels.fetch(item.sourceChannelId);
          if (sourceChannel?.messages) {
            const sourceMessage = await sourceChannel.messages.fetch(item.sourceMessageId);
            const replyText = url ? `投稿しました\n${url}` : '投稿しました（URL取得失敗）';
            const botReply = await sourceMessage.reply(replyText);

            // Bot返信メッセージIDでも逆引きできるよう byMessageId に追加登録
            if (url) {
              await savePostLog(`queued-reply-${botReply.id}`, url, item.authorId, item.text, {
                sourceMessageId: botReply.id,
                sourceChannelId: botReply.channelId,
                sourceGuildId: botReply.guildId
              });
            }
          }
        } catch (err) {
          console.error('元メッセージへの返信失敗:', err);
        }
      }

      await removePost(item.id);
      await cleanupMediaFiles(item.mediaPaths);

      try {
        await sendCompleteLog(item, url);
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

// 受付ログチャンネル（📥）
function getLogChannels() {
  return client.guilds.cache
    .map((guild) => guild.channels.cache.find((channel) => (
      channel.name === config.logChannelName && channel.isTextBased()
    )))
    .filter(Boolean);
}

// 完了ログチャンネル（📤）
function getCompleteLogChannels() {
  return client.guilds.cache
    .map((guild) => guild.channels.cache.find((channel) => (
      channel.name === config.completeLogChannelName && channel.isTextBased()
    )))
    .filter(Boolean);
}

// 📤 投稿完了ログ → #投稿完了ログ へ送信
async function sendCompleteLog(item, url) {
  const time = new Date().toLocaleString('ja-JP');

  for (const channel of getCompleteLogChannels()) {
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
    ).catch((err) => console.error(`完了ログチャンネルへの送信失敗:`, err));
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

  startMentionNotifier({
    getPage: () => getXPageHandle(),
    intervalMs: config.mentionIntervalMinutes * 60_000,
    onNewMention: notifyMention
  });
});

// メンションチャンネル取得
function getMentionChannels() {
  return client.guilds.cache
    .map((guild) => guild.channels.cache.find((channel) => (
      channel.name === config.mentionChannelName && channel.isTextBased()
    )))
    .filter(Boolean);
}

// 新着メンションをDiscordに投稿する
async function notifyMention(url) {
  for (const channel of getMentionChannels()) {
    await channel.send(
`📣 メンションが届きました

${url}

このメッセージに返信するとXでリプライができます`
    ).catch((err) => console.error('メンション通知送信失敗:', err));
  }
  console.log(`Mention notified: ${url}`);
}

async function shutdown() {
  stopMentionNotifier();
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

  // メンションチャンネル（返信 → Xでリプライ）
  if (channelName === config.mentionChannelName) {
    // 返信でない場合は無視
    if (!message.reference?.messageId) return;

    try {
      const referenced = await fetchReferencedMessage(message);
      if (!referenced) {
        await message.reply('返信元のメッセージが取得できませんでした');
        return;
      }

      // 返信元メッセージからXのURLを抽出
      const targetUrl = extractXUrl(referenced.content);
      if (!targetUrl) {
        await message.reply('返信元にXのURLが見つかりませんでした');
        return;
      }

      await message.reply('リプライします');
      const replyUrl = await replyToX(targetUrl, text);
      await recordSuccessfulPost(message.author.id);
      await message.reply(replyUrl ? `リプライしました
${replyUrl}` : 'リプライしました（URL取得失敗）');

    } catch (error) {
      console.error('Reply to X failed:', error);
      await message.reply('リプライに失敗しました。ログを確認してください');
    }
    return;
  }

  // 即時投稿チャンネル
  if (channelName === config.unrestrictedChannelName) {
    let mediaPaths = [];
    try {
      mediaPaths = await saveImageAttachments(message);

      const { url: quotedUrl } = await resolveQuoteUrl(message);
      const finalText = quotedUrl ? `${text}\n\n${quotedUrl}` : text;
      const isQuote = !!quotedUrl;

      await message.reply(isQuote ? '引用RTとして投稿します' : '即時投稿します');

      const url = await postToX(finalText, mediaPaths);
      if (url) {
        await savePostLog(`immediate-${message.id}`, url, message.author.id, finalText, {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          sourceGuildId: message.guildId
        });
      }
      await recordSuccessfulPost(message.author.id);
      await message.reply('投稿しました');

      try {
        await sendCompleteLog({
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
      const { url: quotedUrl, pendingMessageId } = await resolveQuoteUrl(message);

      // URL が即時解決できた場合は finalText に付加、待機中の場合は pendingQuoteMessageId に保存
      const finalText = quotedUrl ? `${text}\n\n${quotedUrl}` : text;

      const code = text ? await moderatePost(text) : 0;
      if (code === 0) {
        const mediaPaths = await saveImageAttachments(message);

        const { position, item } = await enqueuePost(finalText, message.author.id, mediaPaths, {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          sourceGuildId: message.guildId,
          pendingQuoteMessageId: pendingMessageId  // null なら通常キュー
        });

        const postTime = estimatePostTime(position);

        // 返信の種類によって受付メッセージを変える
        let replyMsg;
        if (quotedUrl) {
          replyMsg = `受付 #${item.postNo}（引用RT）\n予定投稿: ${postTime.toLocaleString('ja-JP')}`;
        } else if (pendingMessageId) {
          replyMsg = `受付 #${item.postNo}（返信元の投稿完了後に引用RTとして投稿します）\n予定投稿: ${postTime.toLocaleString('ja-JP')} 以降`;
        } else {
          replyMsg = `受付 #${item.postNo}\n予定投稿: ${postTime.toLocaleString('ja-JP')}`;
        }
        await message.reply(replyMsg);

        // 📥 受付ログ → #投稿ログ
        for (const logChannel of getLogChannels()) {
          await logChannel.send(
`📥 投稿受付

No:#${item.postNo}${pendingMessageId ? '（引用RT待機中）' : quotedUrl ? '（引用RT）' : ''}

投稿者:
<@${message.author.id}>

予定投稿:
${postTime.toLocaleString('ja-JP')}${pendingMessageId ? ' 以降' : ''}

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
