// XML declarations and HTML <meta> charsets are ASCII, so a latin1 preview reads them from any byte stream.
const declaredCharset = /<\?xml[^>]+encoding=["']([^"']+)|<meta[^>]+charset=["']?([^"'>\s;/]+)/i;

export async function decodeResponseBody(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let charset = /charset=([^;]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  if (charset === undefined) {
    const declaration = declaredCharset.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 1024)));
    charset = declaration?.[1] ?? declaration?.[2];
  }
  const label = (charset ?? "utf-8").trim().replace(/["']/g, "");
  try {
    // ponytail: WHATWG labels already cover gb2312/gbk/big5; only the legacy *936 aliases need mapping.
    return new TextDecoder(/^(?:cp|ms|windows-)936$/i.test(label) ? "gbk" : label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
