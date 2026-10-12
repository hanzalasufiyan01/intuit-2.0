import { isIP } from 'node:net';

/**
 * Destination rules for webhook endpoints (ADR 0011 section 11.3, D7 — FROZEN). These checks are
 * the application's own SSRF protection and must be sufficient without any egress proxy:
 *
 *  - HTTPS only, an allowed port (443 by default), no userinfo, no fragment;
 *  - the host is a DNS name: IP literals in any notation, `localhost`, single-label names and the
 *    internal suffixes `.local`, `.internal`, `.lan` (and similar) are refused;
 *  - EVERY address the name resolves to must be a public unicast address; loopback, RFC 1918,
 *    link-local (incl. 169.254.169.254), CGNAT, multicast, reserved and documentation ranges, IPv6
 *    loopback/ULA/link-local and every IPv4-mapped/translated IPv6 form are refused.
 *
 * `validateWebhookUrl` is the syntactic half (create/update and every delivery); the resolution
 * half lives in the transport, which connects to the validated address (pinned).
 */

export class WebhookDestinationError extends Error {
  constructor(
    /** Stable class recorded in the delivery history. */
    readonly errorClass: 'invalid_url' | 'blocked_address' | 'dns',
    message: string,
  ) {
    super(message);
  }
}

const BLOCKED_SUFFIXES = [
  '.local',
  '.localhost',
  '.localdomain',
  '.internal',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.private',
  '.arpa',
];

export interface ValidatedUrl {
  url: URL;
  hostname: string;
  port: number;
}

export function validateWebhookUrl(
  value: string,
  options: { allowedPorts?: readonly number[] } = {},
): ValidatedUrl {
  const allowedPorts = options.allowedPorts ?? [443];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookDestinationError('invalid_url', 'The URL is not valid.');
  }
  if (value.length > 2048) throw new WebhookDestinationError('invalid_url', 'The URL is too long.');
  if (url.protocol !== 'https:') {
    throw new WebhookDestinationError('invalid_url', 'Only https:// URLs are allowed.');
  }
  if (url.username || url.password) {
    throw new WebhookDestinationError('invalid_url', 'The URL must not contain credentials.');
  }
  if (url.hash) {
    throw new WebhookDestinationError('invalid_url', 'The URL must not have a fragment.');
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (!allowedPorts.includes(port)) {
    throw new WebhookDestinationError('invalid_url', 'This port is not allowed.');
  }
  // `new URL` normalizes numeric hosts (decimal, octal, hex) to dotted form, so isIP sees them.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0 || hostname.startsWith('[')) {
    throw new WebhookDestinationError(
      'invalid_url',
      'The host must be a DNS name, not an IP address.',
    );
  }
  if (
    hostname.length > 253 ||
    hostname.split('.').some((label) => label.length > 63) ||
    hostname === 'localhost' ||
    !hostname.includes('.') ||
    BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
  ) {
    throw new WebhookDestinationError('invalid_url', 'The host is not a public DNS name.');
  }
  return { url, hostname, port };
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function publicIpv4(b: number[]): boolean {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!];
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a === 100 && c >= 64 && c <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 169 && c === 254) return false; // link-local incl. cloud metadata
  if (a === 172 && c >= 16 && c <= 31) return false; // private
  if (a === 192 && c === 0 && (d === 0 || d === 2)) return false; // IETF protocol / TEST-NET-1
  if (a === 192 && c === 88 && d === 99) return false; // 6to4 relay (deprecated)
  if (a === 192 && c === 168) return false; // private
  if (a === 198 && (c === 18 || c === 19)) return false; // benchmarking
  if (a === 198 && c === 51 && d === 100) return false; // TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expands an IPv6 address (with `::` and an optional embedded IPv4) into 8 groups; null if invalid. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4Bytes(tail);
    if (!v4) return null;
    const high = ((v4[0]! << 8) | v4[1]!).toString(16);
    const low = ((v4[2]! << 8) | v4[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...rest];
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function publicIpv6(g: number[]): boolean {
  const first = g[0]!;
  // Only global unicast 2000::/3 can be public; everything else (::, ::1, ::ffff:0:0/96 mapped,
  // 64:ff9b::/96 NAT64, fc00::/7 ULA, fe80::/10, ff00::/8, 100::/64 ...) is refused.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return false; // Teredo, documentation
  if (first === 0x2001 && (g[1]! & 0xfff0) === 0x0010) return false; // ORCHID
  if (first === 0x2002) return false; // 6to4 embeds an arbitrary IPv4
  if (first === 0x3fff && (g[1]! & 0xf000) === 0) return false; // documentation 3fff::/20
  return true;
}

/** True only for a public unicast address; anything unparsable is refused. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const bytes = ipv4Bytes(address);
    return bytes !== null && publicIpv4(bytes);
  }
  if (version === 6) {
    const groups = ipv6Groups(address);
    return groups !== null && publicIpv6(groups);
  }
  return false;
}
