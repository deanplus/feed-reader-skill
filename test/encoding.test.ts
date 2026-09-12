import assert from "node:assert/strict";
import test from "node:test";
import { decodeResponseBody } from "../src/encoding.ts";

const chinese = "中文测试";
const chineseGbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];

function gbkResponse(prefix: string, init?: ResponseInit): Response {
  return new Response(Uint8Array.from([...new TextEncoder().encode(prefix), ...chineseGbk]), init);
}

test("decodeResponseBody honours a quoted HTTP header charset", async () => {
  const response = gbkResponse("<title>", { headers: { "content-type": 'application/xml; charset="GBK"' } });
  assert.equal(await decodeResponseBody(response), `<title>${chinese}`);
});

test("decodeResponseBody sniffs the XML declaration when the header omits a charset", async () => {
  const response = gbkResponse('<?xml version="1.0" encoding="gb2312"?><title>', {
    headers: { "content-type": "application/xml" },
  });
  assert.equal(await decodeResponseBody(response), `<?xml version="1.0" encoding="gb2312"?><title>${chinese}`);
});

test("decodeResponseBody sniffs both HTML meta charset forms", async () => {
  const bare = await decodeResponseBody(gbkResponse("<html><meta charset=gbk><title>"));
  assert.ok(bare.endsWith(chinese), bare);
  const httpEquiv = await decodeResponseBody(
    gbkResponse('<html><meta http-equiv="Content-Type" content="text/html; charset=gbk" /><title>'),
  );
  assert.ok(httpEquiv.endsWith(chinese), httpEquiv);
});

test("decodeResponseBody maps legacy cp936 aliases to gbk", async () => {
  const response = gbkResponse("<title>", { headers: { "content-type": "text/xml; charset=cp936" } });
  assert.equal(await decodeResponseBody(response), `<title>${chinese}`);
});

test("decodeResponseBody falls back to utf-8 for undeclared and unsupported charsets", async () => {
  const undeclared = new Response(new TextEncoder().encode(`<rss>${chinese}</rss>`));
  assert.equal(await decodeResponseBody(undeclared), `<rss>${chinese}</rss>`);

  const unsupported = gbkResponse("<title>", { headers: { "content-type": "text/xml; charset=unsupported-xyz" } });
  assert.ok((await decodeResponseBody(unsupported)).includes("�"));
});
