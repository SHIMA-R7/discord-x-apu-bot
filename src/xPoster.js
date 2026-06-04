import { chromium } from 'playwright';
import { config } from './config.js';

let xPostChain = Promise.resolve();
let xContext = null;
let xPage = null;

// 投稿・返信ボタンを最大 maxAttempts 回押して URL 遷移を待つ共通ヘルパー
async function clickUntilNavigated(page, buttonLocator, successPattern, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await buttonLocator.click({ force: true });
    } catch {
      // ボタンが一時的に消えていても続行
    }

    // waitForURL は失敗時に例外を投げるので try/catch で包む
    const navigated = await Promise.race([
      page.waitForURL(successPattern, { timeout: 8000 })
        .then(() => true)
        .catch(() => false),
      page.waitForTimeout(8000).then(() => false)
    ]);

    if (navigated) return true;

    if (attempt < maxAttempts) {
      await page.waitForTimeout(1500);
    }
  }
  return false;
}

function buildLaunchOptions() {
  const options = {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  };

  if (config.xBrowserChannel) {
    options.channel = config.xBrowserChannel;
  }

  return options;
}

async function getXPage() {
  if (xPage && !xPage.isClosed()) {
    return xPage;
  }

  if (!xContext) {
    try {
      xContext = await chromium.launchPersistentContext(
        config.xProfileDir,
        buildLaunchOptions()
      );
    } catch (error) {
      throw new Error(`X browser launch failed. Check X_BROWSER_CHANNEL=${config.xBrowserChannel}: ${error.message}`);
    }
  }

  xPage = xContext.pages()[0] || await xContext.newPage();

  return xPage;
}

export async function closeXBrowser() {
  if (!xContext) return;

  await xContext.close();

  xContext = null;
  xPage = null;
}

// ページ取得を外部（xNotifier）に公開する
export function getXPageHandle() {
  return getXPage();
}

async function doPostToX(text, mediaPaths = []) {
  const page = await getXPage();

  await page.goto(
    'https://x.com/compose/post',
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }
  );

  if (page.url().includes('/login')) {
    throw new Error('Xログインが必要です');
  }

  if (text) {
    const editor = page
      .locator('div[role="textbox"]')
      .first();

    await editor.waitFor({
      timeout: 60000
    });

    await editor.click();

    await editor.pressSequentially(text);
  }

  if (mediaPaths.length > 0) {
    const mediaInput = page
      .locator('input[data-testid="fileInput"]')
      .first();

    await mediaInput.setInputFiles(mediaPaths);

    await page.waitForTimeout(5000);
  }

  const postButton = page
    .locator('[data-testid="tweetButton"]')
    .first();

  await postButton.waitFor({
    timeout: 60000
  });

  const postSuccessPattern = /\/(status\/\d+|home)/;
  await clickUntilNavigated(page, postButton, postSuccessPattern);

  const directUrl = page.url();
  if (directUrl.match(/\/status\/\d+/)) {
    return directUrl;
  }

  if (page.url().includes('/home')) {
    try {
      await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 });

      const statusSelector = config.xUsername
        ? `[data-testid="tweet"] a[href*="/${config.xUsername}/status/"]`
        : '[data-testid="tweet"] a[href*="/status/"]';

      const firstStatusUrl = await page
        .locator(statusSelector)
        .first()
        .getAttribute('href');

      if (firstStatusUrl) {
        return `https://x.com${firstStatusUrl}`;
      }
    } catch {
      // 取得失敗してもクラッシュさせない
    }
  }

  return null;
}

async function doLikeToX(url) {
  const page = await getXPage();

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(3000);

  const likeButton = page.locator('[data-testid="like"]').first();

  await likeButton.click({ force: true });

  await page.waitForTimeout(2000);
}

async function doRetweetToX(url) {
  const page = await getXPage();

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(3000);

  const repostButton = page.locator('[data-testid="retweet"]').first();
  await repostButton.waitFor({ state: 'visible', timeout: 10000 });
  await repostButton.click({ force: true });

  // ポップアップメニューが出るまで待機してから確認ボタンをクリック
  const confirmButton = page.locator('[data-testid="retweetConfirm"]').first();
  await confirmButton.waitFor({ state: 'visible', timeout: 10000 });
  await confirmButton.click({ force: true });

  await page.waitForTimeout(2000);
}

// 指定URLのポストにリプライする
async function doReplyToX(targetUrl, text) {
  const page = await getXPage();

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  if (page.url().includes('/login')) {
    throw new Error('Xログインが必要です');
  }

  // ポストが描画されるまで待機
  await page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 });
  await page.waitForTimeout(2000);

  // 返信ボタンをクリック（ポスト本体の reply ボタン = 最初の1つ目）
  const replyButton = page.locator('[data-testid="reply"]').first();
  await replyButton.waitFor({ timeout: 10000 });
  await replyButton.click({ force: true });

  // テキストボックスが出現するまで待機
  const replyEditor = page.locator('[data-testid="tweetTextarea_0"]').first();
  await replyEditor.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(800);

  await replyEditor.click({ force: true });
  await page.waitForTimeout(500);
  await replyEditor.pressSequentially(text);
  await page.waitForTimeout(1000);

  // デバッグ用スクリーンショット（テキスト入力後・ボタン探索前）
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.resolve('data', 'debug');
    await fs.mkdir(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `reply-before-button-${Date.now()}.png`), fullPage: false });
  } catch {}

  // 返信フォームの「返信」ボタンは data-testid="tweetButtonInline"
  const postSuccessPattern = /\/(status\/\d+|home)/;

  const replyPostButton = page.locator('[data-testid="tweetButtonInline"]').first();
  await replyPostButton.waitFor({ state: 'visible', timeout: 10000 });
  await clickUntilNavigated(page, replyPostButton, postSuccessPattern);

  const finalUrl = page.url();
  return finalUrl.match(/\/status\/\d+/) ? finalUrl : null;
}

export async function ensureXBrowserReady() {
  await getXPage();
}

export async function openXBrowserForLogin() {
  let context;
  try {
    context = await chromium.launchPersistentContext(
      config.xProfileDir,
      buildLaunchOptions()
    );
  } catch (error) {
    throw new Error(`X browser launch failed. Check X_BROWSER_CHANNEL=${config.xBrowserChannel}: ${error.message}`);
  }

  const page = context.pages()[0] || await context.newPage();

  await page.goto(
    'https://x.com/login',
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }
  );

  return context;
}

// 全ての X 操作を xPostChain で直列化する共通ヘルパー
function enqueueXAction(fn) {
  const next = xPostChain.then(fn);
  xPostChain = next.catch(() => {});
  return next;
}

export function postToX(text, mediaPaths = []) {
  return enqueueXAction(() => doPostToX(text, mediaPaths));
}

export function likeToX(url) {
  return enqueueXAction(() => doLikeToX(url));
}

export function retweetToX(url) {
  return enqueueXAction(() => doRetweetToX(url));
}

export function replyToX(targetUrl, text) {
  return enqueueXAction(() => doReplyToX(targetUrl, text));
}
