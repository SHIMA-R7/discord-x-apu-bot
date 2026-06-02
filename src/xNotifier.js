import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve('data');
const notifiedFile = path.join(dataDir, 'notifiedMentions.json');

// ---- 永続化 ----

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
  // 最新500件だけ保持してファイルが膨らまないようにする
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

// ---- 人間的な待機ヘルパー ----

function randomBetween(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function humanWait(page, minMs, maxMs) {
  await page.waitForTimeout(randomBetween(minMs, maxMs));
}

async function humanScroll(page) {
  // ランダムな量だけゆっくりスクロール
  const scrollAmount = randomBetween(200, 600);
  await page.evaluate((amount) => {
    window.scrollBy({ top: amount, behavior: 'smooth' });
  }, scrollAmount);
  await humanWait(page, 800, 2000);
}

// ---- メンション取得 ----

export async function fetchMentions(page) {
  // 巡回前にランダム待機（30秒〜2分）で定期アクセスのパターンを崩す
  await humanWait(page, 30_000, 120_000);

  await page.goto('https://x.com/notifications/mentions', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  if (page.url().includes('/login')) {
    throw new Error('Xログインが必要です（通知取得）');
  }

  // タイムライン描画待ち
  try {
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 });
  } catch {
    // 通知がゼロの場合もあるので続行
    return [];
  }

  // 少し読んでからスクロール（人間らしく）
  await humanWait(page, 1500, 3500);
  await humanScroll(page);
  await humanWait(page, 1000, 2500);

  // メンション通知ツイートのパーマリンクを全件取得
  const hrefs = await page.locator('[data-testid="tweet"] a[href*="/status/"]').evaluateAll(
    (anchors) => anchors.map((a) => a.getAttribute('href'))
  );

  // /status/数字 の形式だけ残して重複排除
  const urls = [...new Set(
    hrefs
      .filter((h) => h && /\/status\/\d+/.test(h))
      .map((h) => `https://x.com${h}`)
  )];

  return urls;
}

// ---- 通知ループ（index.js から呼び出す） ----

let notifyTimer = null;

export function startMentionNotifier({ getPage, intervalMs, onNewMention }) {
  async function run() {
    try {
      const page = await getPage();
      const urls = await fetchMentions(page);

      for (const url of urls) {
        if (await isNotified(url)) continue;
        await markNotified(url);

        try {
          await onNewMention(url);
        } catch (err) {
          console.error('onNewMention failed:', err);
        }

        // 通知を1件ずつ処理する間も少し間を空ける
        await humanWait(page, 1000, 3000);
      }
    } catch (err) {
      console.error('Mention notifier error:', err);
    } finally {
      notifyTimer = setTimeout(run, intervalMs);
    }
  }

  // 初回は即時実行せず1インターバル後に開始（Bot起動直後の負荷を避ける）
  notifyTimer = setTimeout(run, intervalMs);
}

export function stopMentionNotifier() {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}
