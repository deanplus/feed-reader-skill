import type { BrowserType } from "playwright-core";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ChromiumLoader = () => Promise<BrowserType>;

export interface WafFetchOptions {
  chromium?: ChromiumLoader;
  fetcher?: Fetcher;
}

const challengeDelayMs = 1_500;

export function normalizeWafUrl(url: string): string {
  const target = new URL(url);
  if (target.searchParams.get("mod") === "rss" && target.searchParams.get("auth") === "0") {
    target.searchParams.delete("auth");
  }
  return target.toString();
}

export function chromeUserAgent(version: string, platform?: string): string {
  const resolvedPlatform = platform ?? process.platform;
  const system = resolvedPlatform === "win32"
    ? "Windows NT 10.0; Win64; x64"
    : resolvedPlatform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  /* node:coverage ignore next */
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

async function loadChromium(): Promise<BrowserType> {
  /* node:coverage ignore next */
  return (await import("playwright-core")).chromium;
}

export async function fetchWafProtectedText(
  url: string,
  accept: string,
  timeoutMs: number,
  options: WafFetchOptions,
): Promise<string> {
  const target = normalizeWafUrl(url);
  const chromium = await (options.chromium ?? loadChromium)();
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: timeoutMs });
  try {
    const userAgent = chromeUserAgent(browser.version());
    const context = await browser.newContext({ userAgent });
    try {
      const page = await context.newPage();
      let blockReload = false;
      await page.route(target, async (route) => {
        if (blockReload && route.request().isNavigationRequest()) {
          await route.abort();
        } else {
          await route.continue();
        }
      });
      await page.goto(target, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      if (!(await page.content()).includes("waf_pow")) {
        throw new Error("Unsupported browser challenge");
      }
      const button = page.locator("button");
      if (await button.count() !== 1) {
        throw new Error("Browser challenge button not found");
      }

      // ponytail: known waf_pow flow only; add adapters when another real challenge requires one.
      await page.waitForTimeout(challengeDelayMs);
      blockReload = true;
      const reload = page.waitForRequest(
        (request) => request.isNavigationRequest() && request.url() === target,
        { timeout: timeoutMs },
      );
      await button.click({ timeout: timeoutMs });
      await reload;

      const cookies = await context.cookies(target);
      if (!cookies.some((cookie) => cookie.name === "waf_pow")) {
        throw new Error("Browser challenge did not produce a WAF cookie");
      }
      const response = await (options.fetcher ?? globalThis.fetch)(target, {
        headers: {
          accept,
          cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
          "user-agent": userAgent,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const wafAction = response.headers.get("x-waf-action");
      if (wafAction === "block" || wafAction === "challenge") {
        throw new Error(`WAF challenge still active after browser challenge: ${wafAction}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} after browser challenge`);
      }
      return response.text();
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
