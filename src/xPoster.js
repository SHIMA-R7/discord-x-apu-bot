import { chromium } from 'playwright';
import { config } from './config.js';

let xPostChain = Promise.resolve();
let xContext = null;
let xPage = null;

function buildLaunchOptions() {
  const options = {
    headless: false
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
      xContext = await chromium.launchPersistentContext(config.xProfileDir, buildLaunchOptions());
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

  await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
  if (text) {
    const editor = page.locator('[data-testid="tweetTextarea_0"]').first();
    await editor.waitFor({ timeout: 30_000 });
    await editor.fill(text);
  }

  if (mediaPaths.length > 0) {
    const mediaInput = page.locator('input[data-testid="fileInput"]').first();
    await mediaInput.setInputFiles(mediaPaths);
    await page.waitForTimeout(3000);
  }

  const postButton = page.locator('[data-testid="tweetButton"]').first();
  await postButton.waitFor({ timeout: 30_000 });
  await postButton.click();
  await page.waitForTimeout(3000);
}

export async function ensureXBrowserReady() {
  await getXPage();
}

export async function openXBrowserForLogin() {
  let context;
  try {
    context = await chromium.launchPersistentContext(config.xProfileDir, buildLaunchOptions());
  } catch (error) {
    throw new Error(`X browser launch failed. Check X_BROWSER_CHANNEL=${config.xBrowserChannel}: ${error.message}`);
  }
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });
  return context;
}

export function postToX(text, mediaPaths = []) {
  const nextPost = xPostChain.then(() => doPostToX(text, mediaPaths));
  xPostChain = nextPost.catch(() => {});
  return nextPost;
}
