/* node:coverage disable */
// Loading real Chrome is untestable, and the bundler's injected dynamic-import interop
// leaves an unreachable branch, so this module stays outside coverage.
import type { BrowserType } from "playwright-core";

export async function loadChromium(): Promise<BrowserType> {
  return (await import("playwright-core")).chromium;
}
