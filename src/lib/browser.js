let _browser = null;

export async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const { chromium } = await import("playwright");
  _browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

export async function newPage() {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  return ctx.newPage();
}

// Utility: wait for selector with timeout, return null if not found
export async function safeWait(page, selector, timeout = 10000) {
  try {
    return await page.waitForSelector(selector, { timeout });
  } catch {
    return null;
  }
}

// Utility: get text content safely
export async function getText(page, selector) {
  try {
    const el = await page.$(selector);
    if (el) return (await el.textContent())?.trim() || "";
  } catch {}
  return "";
}
