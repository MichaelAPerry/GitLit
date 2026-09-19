import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { toolRejected } from "@gitlit/core";

/**
 * SSRF guard for `gitlit_add_source` (§12.8).
 *
 * The server fetches URLs an external agent supplies, which makes it a
 * confused deputy by default: the agent is untrusted, our network position is
 * not. Everything private, loopback, link-local, or cloud-metadata is refused,
 * and the check runs against the RESOLVED address, not just the hostname.
 */

const BLOCKED_V4 = [
  { net: "0.0.0.0", bits: 8 },        // this network
  { net: "10.0.0.0", bits: 8 },       // private
  { net: "100.64.0.0", bits: 10 },    // CGNAT
  { net: "127.0.0.0", bits: 8 },      // loopback
  { net: "169.254.0.0", bits: 16 },   // link-local + cloud metadata
  { net: "172.16.0.0", bits: 12 },    // private
  { net: "192.0.0.0", bits: 24 },
  { net: "192.168.0.0", bits: 16 },   // private
  { net: "198.18.0.0", bits: 15 },    // benchmarking
  { net: "224.0.0.0", bits: 4 },      // multicast
  { net: "240.0.0.0", bits: 4 },      // reserved
];

const toInt = (ip: string) =>
  ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const value = toInt(ip);
    return BLOCKED_V4.some(({ net, bits }) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (toInt(net) & mask);
    });
  }
  if (version === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    // IPv4-mapped (::ffff:127.0.0.1) must be unwrapped, not trusted.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return false;
  }
  return true;
}

export const MAX_FETCH_BYTES = 2_000_000;

export interface FetchedSource {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

/** Validates scheme and resolved address before any request is made. */
export async function assertFetchable(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw toolRejected("invalid_url", `Not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw toolRejected("blocked_scheme", `Only http and https may be fetched, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw toolRejected("blocked_credentials", "URLs with embedded credentials are refused");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw toolRejected("blocked_address", `Refused private address ${host}`);
    return url;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw toolRejected("blocked_address", `Refused internal hostname ${host}`);
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw toolRejected("dns_failed", `Could not resolve ${host}`);
  }
  if (addresses.length === 0) throw toolRejected("dns_failed", `No address for ${host}`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw toolRejected("blocked_address", `${host} resolves to a private address`);
    }
  }
  return url;
}

/**
 * Fetch with a size cap and no redirects to unvetted hosts. Redirects are
 * followed manually so each hop is re-checked — a permissive redirect is the
 * usual way an SSRF guard gets walked around.
 */
export async function fetchSource(raw: string, maxHops = 3): Promise<FetchedSource> {
  let current = raw;
  for (let hop = 0; hop <= maxHops; hop++) {
    const url = await assertFetchable(current);
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "GitLit/0.1 (+https://gitlit.app/bot)" },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw toolRejected("fetch_failed", `Redirect with no location from ${current}`);
      current = new URL(location, url).toString();
      continue;
    }

    const body = await res.arrayBuffer();
    const truncated = body.byteLength > MAX_FETCH_BYTES;
    const text = new TextDecoder().decode(body.slice(0, MAX_FETCH_BYTES));
    return {
      url: url.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text,
      truncated,
    };
  }
  throw toolRejected("too_many_redirects", `Too many redirects from ${raw}`);
}

/** Crude tag strip — enough to store a readable excerpt, not a renderer. */
export function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
