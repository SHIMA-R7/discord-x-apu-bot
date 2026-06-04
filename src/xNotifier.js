import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve('data');
const notifiedFile = path.join(dataDir, 'notifiedMentions.json');
const actionQueueFile = path.join(dataDir, 'mentionActionQueue.json');

// ---- 既通知管理 ----

async function readNotified() {
  try {
    const raw = await fs.readFile(notifiedFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeNotified(urls) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(notifiedFile, JSON.stringify(urls.slice(-500), null, 2), 'utf8');
}

async function markNotified(url) {
  const notified = await readNotified();
  if (notified.includes(url)) return;
  notified.push(url);
  await writeNotified(notified);
}

async function isNotified(url) {
  const notified = await readNotified();
  return notified.includes(url);
}

// ---- いいね＋RTアクションキュー管理 ----

async function readActionQueue() {
  try {
    const raw = await fs.readFile(actionQueueFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeActionQueue(queue) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(actionQueueFile, JSON.stringify(queue, null, 2), 'utf8');
}

export async function enqueueAction(url) {
  const queue = await readActionQueue();
  if (queue.includes(url)) return; // 重複防止
  queue.push(url);
  await writeActionQueue(queue);
}

async function shiftAction() {
  const queue = await readActionQueue();
  if (queue.length === 0) return null;
  const url = queue.shift();
  await writeActionQueue(queue);
  return url;
}

export async function getActionQueueLength() {
  return (await readActionQueue()).length;
}

// ---- 人間的な待機ヘルパー ----

function randomBetween(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function humanWait(page, minMs, maxMs) {
  await page.waitForTimeout(randomBetween(minMs, maxMs));
}

async function humanScroll(page) {
  const scrollAmount = randomBetween(200, 600);
  await page.evaluate((amount) => {
    window.scrollBy({ top: amount, behavior: 'smooth' });
  }, scrollAmount);
  await humanWait(page, 800, 2000);
}

// ---- メンション取得 ----

export async function fetchMentions(page) {
  // 巡回前にランダム待機（30秒〜2分）
  await humanWait(page, 30_000, 120_000);

  await page.goto('https://x.com/notifications/mentions', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  if (page.url().includes('/login')) {
    throw new Error('Xログインが必要です（通知取得）');
  }

  try {
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 });
  } catch {
    return [];
  }

  await humanWait(page, 1500, 3500);
  await humanScroll(page);
  await humanWait(page, 1000, 2500);

  const hrefs = await page.locator('[data-testid="tweet"] a[href*="/status/"]').evaluateAll(
    (anchors) => anchors.map((a) => a.getAttribute('href'))
  );

  // /status/数字 で終わるURLだけ残して重複排除（/photo/1 や /analytics を除外）
  const urls = [...new Set(
    hrefs
      .filter((h) => h && /\/status\/\d+$/.test(h))
      .map((h) => `https://x.com${h}`)
  )];

  return urls;
}

// ---- 通知ループ（index.js から呼び出す） ----

let notifyTimer = null;

export function startMentionNotifier({ getPage, intervalMs, onNewMention, likeToX, retweetToX }) {
  async function run() {
    try {
      const page = await getPage();
      const urls = await fetchMentions(page);

      // 新着メンションをDiscord通知 ＋ アクションキューに追加
      for (const url of urls) {
        if (await isNotified(url)) continue;
        await markNotified(url);

        try {
          await onNewMention(url);
        } catch (err) {
          console.error('onNewMention failed:', err);
        }

        await enqueueAction(url);
        console.log(`Queued like+RT for: ${url}`);

        await humanWait(page, 1000, 3000);
      }

      // アクションキューから1件だけいいね＋RTを処理する（10分に1件ペース）
      const actionUrl = await shiftAction();
      if (actionUrl) {
        try {
          // いいね → 少し間を置いて → RT の順
          await likeToX(actionUrl);
          await humanWait(page, 2000, 5000);
          await retweetToX(actionUrl);
          console.log(`Like+RT done: ${actionUrl}`);
        } catch (err) {
          console.error(`Like+RT failed for ${actionUrl}:`, err);
          // 失敗したURLはキューの末尾に戻して再試行
          await enqueueAction(actionUrl);
        }
      }

    } catch (err) {
      console.error('Mention notifier error:', err);
    } finally {
      notifyTimer = setTimeout(run, intervalMs);
    }
  }

  notifyTimer = setTimeout(run, intervalMs);
}

export function stopMentionNotifier() {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}
