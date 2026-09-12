import type { BrowserType } from "playwright-core";
import { loadChromium } from "./chromium.ts";
import { decodeResponseBody } from "./encoding.ts";

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
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
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
      await button.click({ timeout: timeoutMs, noWaitAfter: true });
      let cookies = await context.cookies(target);
      for (let elapsed = 0; !cookies.some((cookie) => cookie.name === "waf_pow") && elapsed < timeoutMs; elapsed += 100) {
        await page.waitForTimeout(Math.min(100, timeoutMs - elapsed));
        cookies = await context.cookies(target);
      }
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
      return decodeResponseBody(response);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
