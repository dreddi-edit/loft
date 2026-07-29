import { isIP } from "node:net";

export const UNKNOWN_CLIENT_IP = "unknown";

export const DEFAULT_TRUSTED_HOPS = 1;

export type ClientIpSource = "forwarded-for" | "x-real-ip" | "unknown";

export type ClientIpResult = {
  ip: string;
  key: string;
  source: ClientIpSource;
  trusted: boolean;
  chain: string[];
};

export type ResolveClientIpOptions = {
  trustedHops?: number;
};

export function getTrustedHops(): number {
  const raw = process.env.RATE_LIMIT_TRUSTED_HOPS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRUSTED_HOPS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_TRUSTED_HOPS;
  return parsed;
}

export function normalizeIp(raw: string): string | null {
  let value = raw.trim();
  if (value === "") return null;

  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    if (closing < 0) return null;
    value = value.slice(1, closing);
  } else if (value.includes(":")) {
    const firstColon = value.indexOf(":");
    const lastColon = value.lastIndexOf(":");
    if (firstColon === lastColon) {
      value = value.slice(0, firstColon);
    }
  }

  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (value === "") return null;

  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  const lower = value.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  return lower;
}

export function parseForwardedFor(header: string | null): string[] {
  if (!header) return [];
  const result: string[] = [];
  for (const candidate of header.split(",")) {
    const normalized = normalizeIp(candidate);
    if (normalized) result.push(normalized);
  }
  return result;
}

function expandIpv6(value: string): string[] | null {
  const sides = value.split("::");
  if (sides.length > 2) return null;

  const toGroups = (part: string): string[] | null => {
    if (part === "") return [];
    const groups: string[] = [];
    for (const group of part.split(":")) {
      if (group.includes(".")) {
        const octets = group.split(".").map((octet) => Number(octet));
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return null;
        groups.push(((octets[0] << 8) | octets[1]).toString(16));
        groups.push(((octets[2] << 8) | octets[3]).toString(16));
        continue;
      }
      groups.push(group);
    }
    return groups;
  };

  const head = toGroups(sides[0]);
  const tail = sides.length === 2 ? toGroups(sides[1]) : [];
  if (!head || !tail) return null;

  const missing = 8 - head.length - tail.length;
  if (sides.length === 1) return head.length === 8 ? head : null;
  if (missing < 0) return null;
  return [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
}

/**
 * IPv6 clients routinely control an entire /64, so a per-address bucket is trivially
 * escaped by rotating the host part. IPv4 addresses are used verbatim.
 */
export function toRateLimitKey(ip: string): string {
  if (ip === UNKNOWN_CLIENT_IP) return ip;
  if (isIP(ip) === 4) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * Cloud Run behind a global load balancer receives
 *   x-forwarded-for: <anything the client sent>, <real client ip>, <load balancer ip>
 * because every hop appends the peer it accepted the connection from. Only the entries
 * appended by infrastructure we trust are meaningful, so the client address is counted
 * from the RIGHT: `length - 1 - trustedHops`. Reading the leftmost value instead lets an
 * attacker mint a fresh rate limit bucket per request.
 */
export function resolveClientIp(
  headers: Headers,
  options: ResolveClientIpOptions = {},
): ClientIpResult {
  const trustedHops = options.trustedHops ?? getTrustedHops();
  const chain = parseForwardedFor(headers.get("x-forwarded-for"));

  if (chain.length > 0) {
    const index = chain.length - 1 - trustedHops;
    if (index >= 0) {
      const ip = chain[index];
      return { ip, key: toRateLimitKey(ip), source: "forwarded-for", trusted: true, chain };
    }
    const fallback = chain[chain.length - 1];
    return {
      ip: fallback,
      key: toRateLimitKey(fallback),
      source: "forwarded-for",
      trusted: trustedHops === 0,
      chain,
    };
  }

  const realIp = normalizeIp(headers.get("x-real-ip") ?? "");
  if (realIp) {
    return {
      ip: realIp,
      key: toRateLimitKey(realIp),
      source: "x-real-ip",
      trusted: false,
      chain: [realIp],
    };
  }

  return {
    ip: UNKNOWN_CLIENT_IP,
    key: UNKNOWN_CLIENT_IP,
    source: "unknown",
    trusted: false,
    chain: [],
  };
}

export function getClientIp(headers: Headers, options: ResolveClientIpOptions = {}): string {
  return resolveClientIp(headers, options).ip;
}

export function getClientIpKey(headers: Headers, options: ResolveClientIpOptions = {}): string {
  return resolveClientIp(headers, options).key;
}
