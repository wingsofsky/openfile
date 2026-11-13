/** The dev filesystem bridge is a local application API, never a cross-origin API. */
export function assertDevRequest(req, { port, host, https = false }, rawResource = false) {
  const deny = () => { throw Object.assign(new Error("拒绝非本应用请求"), { status: 403 }); };
  const authority = req.headers.host;
  if (typeof authority !== "string" || /[\s/@\\?#]/.test(authority)) deny();
  let url;
  try { url = new URL(`${https ? "https" : "http"}://${authority}`); } catch { deny(); }
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (typeof host === "string" && !["0.0.0.0", "::"].includes(host)) hosts.add(host.toLowerCase());
  if (!hosts.has(url.hostname) || Number(url.port || (https ? 443 : 80)) !== port) deny();
  const method = req.method;
  if (!["GET", "HEAD", "POST"].includes(method)) deny();
  const passive = rawResource && ["GET", "HEAD"].includes(method)
    && ["image", "style", "font", "audio", "video"].includes(req.headers["sec-fetch-dest"]);
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== url.origin && !(origin === "null" && passive)) deny();
  if (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]) && !passive) deny();
  if (method === "POST" && (req.headers["x-openfile-request"] !== "1"
    || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))) deny();
}
