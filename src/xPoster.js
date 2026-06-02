import { chromium } from 'playwright';
import { config } from './config.js';

let xPostChain = Promise.resolve();
let xContext = null;
let xPage = null;

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

  await postButton.click({
    force: true
  });

  // 投稿後は /status/数字 か /home のどちらかに遷移する。
  // どちらにも遷移しなかった場合のみ 2 回目クリックを試みる。
  const postSuccessPattern = /\/(status\/\d+|home)/;

  const navigated = await Promise.race([
    page.waitForURL(postSuccessPattern, { timeout: 10000 }).then(() => true),
    page.waitForTimeout(10000).then(() => false)
  ]);

  if (!navigated) {
    // 10 秒以内に遷移しなかった場合のみ 2 回目クリックを試みる
    try {
      await postButton.click({ force: true, timeout: 3000 });
    } catch {}

    await Promise.race([
      page.waitForURL(postSuccessPattern, { timeout: 10000 }),
      page.waitForTimeout(10000)
    ]);
  }

  // /status/数字 に直接遷移した場合はそのまま返す
  const directUrl = page.url();
  if (directUrl.match(/\/status\/\d+/)) {
    return directUrl;
  }

  // /home に飛んだ場合はタイムライン先頭の自分の投稿リンクからURLを取得する
  if (page.url().includes('/home')) {
    try {
      // タイムラインが描画されるまで待機
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

// [FIX] like / retweet も xPostChain に繋いでブラウザ競合を防ぐ
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

  await repostButton.click({ force: true });

  await page.waitForTimeout(1000);

  const confirmButton = page.locator('[data-testid="retweetConfirm"]').first();

  await confirmButton.click({ force: true });

  await page.waitForTimeout(2000);
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
