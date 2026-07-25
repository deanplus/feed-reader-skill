import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type BrowserType } from "playwright-core";
import { fetchFeed } from "../src/feed.ts";
import { chromeUserAgent, fetchWafProtectedText, normalizeWafUrl } from "../src/waf.ts";

test("normalizeWafUrl removes anonymous Discuz auth only", () => {
  assert.equal(
    normalizeWafUrl("https://example.com/forum.php?mod=rss&fid=81&auth=0"),
    "https://example.com/forum.php?mod=rss&fid=81",
  );
  assert.equal(
    normalizeWafUrl("https://example.com/forum.php?mod=rss&auth=secret"),
    "https://example.com/forum.php?mod=rss&auth=secret",
  );
  assert.equal(
    normalizeWafUrl("https://example.com/page?auth=0"),
    "https://example.com/page?auth=0",
  );
});

test("chromeUserAgent covers supported desktop platforms", () => {
  assert.match(chromeUserAgent("123", undefined), /Chrome\/123/);
  assert.match(chromeUserAgent("123", "darwin"), /Macintosh.*Chrome\/123/);
  assert.match(chromeUserAgent("123", "win32"), /Windows NT 10\.0.*Chrome\/123/);
  assert.match(chromeUserAgent("123", "linux"), /Linux x86_64.*Chrome\/123/);
});

function fakeChromium(mode: "success" | "unsupported" | "missing-button" | "missing-cookie") {
  return async () => ({
    launch: async () => {
      let routeHandler: ((route: {
        abort(): Promise<void>;
        continue(): Promise<void>;
        request(): { isNavigationRequest(): boolean };
      }) => Promise<void>) | undefined;
      let reloadRequest: (() => void) | undefined;
      let continued = false;
      let aborted = false;
      const request = {
        isNavigationRequest: () => true,
        url: () => "https://example.com/forum.php?mod=rss&fid=81",
      };
      const page = {
        click: async () => {},
        content: async () => mode === "unsupported" ? "<html/>" : "<script>waf_pow</script>",
        goto: async () => {
          await routeHandler?.({
            abort: async () => { aborted = true; },
            continue: async () => { continued = true; },
            request: () => request,
          });
        },
        locator: () => ({
          click: async () => {
            await routeHandler?.({
              abort: async () => { aborted = true; },
              continue: async () => { continued = true; },
              request: () => ({ ...request, isNavigationRequest: () => false }),
            });
            await routeHandler?.({
              abort: async () => { aborted = true; },
              continue: async () => { continued = true; },
              request: () => request,
            });
            reloadRequest?.();
          },
          count: async () => mode === "missing-button" ? 0 : 1,
        }),
        route: async (_url: string, handler: typeof routeHandler) => { routeHandler = handler; },
        waitForRequest: async (predicate: (candidate: typeof request) => boolean) => new Promise((resolve) => {
          assert.equal(predicate({ ...request, isNavigationRequest: () => false }), false);
          assert.equal(predicate({ ...request, url: () => "https://example.com/other" }), false);
          reloadRequest = () => {
            assert.equal(predicate(request), true);
            resolve(request);
          };
        }),
        waitForTimeout: async () => {},
      };
      const context = {
        close: async () => {},
        cookies: async () => mode === "missing-cookie"
          ? []
          : [{ name: "waf_pow", value: "proof" }],
        newPage: async () => page,
      };
      return {
        close: async () => {
          assert.equal(continued, true);
          if (mode !== "unsupported" && mode !== "missing-button") {
            assert.equal(aborted, true);
          }
        },
        newContext: async ({ userAgent }: { userAgent: string }) => {
          assert.match(userAgent, /Chrome\/123/);
          return context;
        },
        version: () => "123",
      };
    },
  }) as unknown as Promise<BrowserType>;
}

test("fetchWafProtectedText solves the recognized challenge with an in-memory cookie", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const text = await fetchWafProtectedText(
    "https://example.com/forum.php?mod=rss&fid=81&auth=0",
    "application/rss+xml",
    123,
    {
      chromium: fakeChromium("success"),
      fetcher: async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response("<rss/>");
      },
    },
  );
  assert.equal(text, "<rss/>");
  assert.equal(calls[0]?.input, "https://example.com/forum.php?mod=rss&fid=81");
  assert.equal(new Headers(calls[0]?.init?.headers).get("cookie"), "waf_pow=proof");
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
});

test("fetchFeed uses the built-in WAF solver", async (context) => {
  const fakeType = await fakeChromium("success")();
  const browser = await fakeType.launch();
  context.mock.method(chromium, "launch", async () => browser);
  context.mock.method(globalThis, "fetch", async () =>
    new Response("<rss><channel><item><title>Protected</title><link>https://example.com/item</link></item></channel></rss>"));

  const items = await fetchFeed({
    id: "protected",
    url: "https://example.com/forum.php?mod=rss&fid=81&auth=0",
    type: "rss",
    categories: [],
  }, new Date("2026-07-25T00:00:00Z"), {
    fetcher: async () => new Response("challenge", { headers: { "x-waf-action": "challenge" } }),
  });
  assert.equal(items[0]?.title, "Protected");
});

test("fetchWafProtectedText rejects unsupported or incomplete challenges", async () => {
  for (const [mode, message] of [
    ["unsupported", "Unsupported browser challenge"],
    ["missing-button", "Browser challenge button not found"],
    ["missing-cookie", "Browser challenge did not produce a WAF cookie"],
  ] as const) {
    await assert.rejects(fetchWafProtectedText("https://example.com/forum.php?mod=rss&fid=81", "text/xml", 123, {
      chromium: fakeChromium(mode),
    }), new RegExp(message));
  }

  await assert.rejects(fetchWafProtectedText("https://example.com/forum.php?mod=rss&fid=81", "text/xml", 123, {
    chromium: fakeChromium("success"),
    fetcher: async () => new Response("blocked", { status: 403 }),
  }), /HTTP 403 after browser challenge/);
  await assert.rejects(fetchWafProtectedText("https://example.com/forum.php?mod=rss&fid=81", "text/xml", 123, {
    chromium: fakeChromium("success"),
    fetcher: async () => new Response("challenge", { headers: { "x-waf-action": "challenge" } }),
  }), /WAF challenge still active/);
});
