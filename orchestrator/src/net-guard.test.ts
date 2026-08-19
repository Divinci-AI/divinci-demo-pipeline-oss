import { describe, it, expect, vi } from "vitest";
import { assertFetchable, safeGet, isPrivateAddress, isSameSite, BlockedUrlError } from "./net-guard.js";

/** Resolver stub so these tests never touch real DNS. */
const resolvesTo = (...ips: string[]) => async () => ips;
const PUBLIC = resolvesTo("93.184.216.34");

describe("isPrivateAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "10/8"],
    ["172.16.0.1", "172.16/12"],
    ["172.31.255.254", "172.16/12 upper"],
    ["192.168.1.1", "192.168/16"],
    ["169.254.169.254", "cloud metadata"],
    ["0.0.0.0", "this network"],
    ["100.64.0.1", "CGNAT"],
    ["192.0.0.8", "IETF protocol assignments 192.0.0/24"],
    ["192.0.2.1", "TEST-NET-1 192.0.2/24"],
    ["::1", "IPv6 loopback"],
    ["fe80::1", "IPv6 link-local"],
    ["fd00::1", "IPv6 ULA"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it("allows 192.0.78.x — Automattic/WordPress.com, not reserved", () => {
    // Blocking the whole 192.0.0.0/16 was a real false positive: it refused
    // spacenews.com, and WordPress.com hosting is one of the commonest shapes
    // this pipeline crawls. Only 192.0.0/24 and 192.0.2/24 are reserved.
    expect(isPrivateAddress("192.0.78.25")).toBe(false);
  });

  it.each([["93.184.216.34"], ["8.8.8.8"], ["172.32.0.1"], ["172.15.0.1"], ["2606:2800:220:1::1"]])(
    "allows public %s",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("isSameSite", () => {
  it("accepts the site and its subdomains", () => {
    expect(isSameSite("acmeclinic.com", "acmeclinic.com")).toBe(true);
    expect(isSameSite("www.acmeclinic.com", "acmeclinic.com")).toBe(true);
    expect(isSameSite("blog.acmeclinic.com", "acmeclinic.com")).toBe(true);
  });

  it("rejects a lookalike that merely ENDS with the name", () => {
    // "evilstoneclinic.com".endsWith("acmeclinic.com") is true — the dot is
    // what makes this a subdomain check rather than a substring check.
    expect(isSameSite("evilstoneclinic.com", "acmeclinic.com")).toBe(false);
    expect(isSameSite("acmeclinic.com.evil.net", "acmeclinic.com")).toBe(false);
  });
});

describe("assertFetchable", () => {
  it("allows an ordinary public URL", async () => {
    await expect(assertFetchable("https://acmeclinic.com/sitemap.xml", { resolver: PUBLIC })).resolves.toBeInstanceOf(URL);
  });

  it("blocks localhost by name — review board listens there", async () => {
    await expect(assertFetchable("http://localhost:7777/api/tasks", { resolver: PUBLIC })).rejects.toThrow(BlockedUrlError);
  });

  it("blocks a loopback IP literal without consulting DNS", async () => {
    const resolver = vi.fn(PUBLIC);
    await expect(assertFetchable("http://127.0.0.1:7777/", { resolver })).rejects.toThrow(/private address/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("blocks cloud metadata", async () => {
    await expect(assertFetchable("http://169.254.169.254/latest/meta-data/", { resolver: PUBLIC })).rejects.toThrow(
      /private address/,
    );
  });

  it("blocks a PUBLIC hostname that RESOLVES to loopback", async () => {
    // The interesting attack: a name the attacker controls, pointed inward.
    await expect(
      assertFetchable("http://sitemap.evil.test/x.xml", { resolver: resolvesTo("127.0.0.1") }),
    ).rejects.toThrow(/resolves to a private address/);
  });

  it("blocks a host resolving to BOTH public and private addresses", async () => {
    // Split-horizon answers are a rebinding attempt, not a coincidence.
    await expect(
      assertFetchable("http://mixed.evil.test/x", { resolver: resolvesTo("93.184.216.34", "10.0.0.5") }),
    ).rejects.toThrow(/private address/);
  });

  it("blocks non-HTTP schemes", async () => {
    for (const u of ["file:///etc/passwd", "gopher://x/", "ftp://x/"])
      await expect(assertFetchable(u, { resolver: PUBLIC })).rejects.toThrow(/non-HTTP scheme/);
  });

  it("enforces sameSiteAs for attacker-supplied sitemap URLs", async () => {
    await expect(
      assertFetchable("https://other.example/sitemap.xml", { sameSiteAs: "acmeclinic.com", resolver: PUBLIC }),
    ).rejects.toThrow(/off-site/);
  });

  it("refuses a host that does not resolve at all", async () => {
    await expect(assertFetchable("http://nx.test/", { resolver: resolvesTo() })).rejects.toThrow(/could not resolve/);
  });
});

describe("safeGet redirect handling", () => {
  function fetchStub(steps: Array<{ status: number; location?: string; body?: string }>) {
    let i = 0;
    return vi.fn(async () => {
      const s = steps[Math.min(i++, steps.length - 1)];
      return new Response(s.body ?? "", {
        status: s.status,
        headers: s.location ? { location: s.location } : {},
      });
    }) as unknown as typeof fetch;
  }

  it("returns the body on a plain 200", async () => {
    const res = await safeGet("https://acmeclinic.com/x", {
      fetchImpl: fetchStub([{ status: 200, body: "<loc>a</loc>" }]),
      resolver: PUBLIC,
    });
    expect(res?.body).toBe("<loc>a</loc>");
  });

  it("BLOCKS a redirect from an allowed URL to loopback", async () => {
    // The reason redirect:"manual" exists. fetch follows up to 20 hops by
    // default, so validating only the first URL is not a control at all.
    const impl = fetchStub([
      { status: 302, location: "http://127.0.0.1:7777/api/tasks" },
      { status: 200, body: "SECRET" },
    ]);
    const res = await safeGet("https://acmeclinic.com/sitemap.xml", { fetchImpl: impl, resolver: PUBLIC });
    expect(res).toBeUndefined();
    expect(impl).toHaveBeenCalledTimes(1); // never fetched the redirect target
  });

  it("blocks a redirect that leaves the site when sameSiteAs is set", async () => {
    const impl = fetchStub([
      { status: 302, location: "https://other.example/x" },
      { status: 200, body: "nope" },
    ]);
    const res = await safeGet("https://acmeclinic.com/x", {
      sameSiteAs: "acmeclinic.com",
      fetchImpl: impl,
      resolver: PUBLIC,
    });
    expect(res).toBeUndefined();
  });

  it("follows a same-site redirect", async () => {
    const impl = fetchStub([
      { status: 301, location: "https://www.acmeclinic.com/sitemap.xml" },
      { status: 200, body: "ok" },
    ]);
    const res = await safeGet("https://acmeclinic.com/sitemap.xml", {
      sameSiteAs: "acmeclinic.com",
      fetchImpl: impl,
      resolver: PUBLIC,
    });
    expect(res?.body).toBe("ok");
  });

  it("gives up on a redirect loop instead of spinning", async () => {
    const impl = fetchStub([{ status: 302, location: "https://acmeclinic.com/loop" }]);
    const res = await safeGet("https://acmeclinic.com/loop", {
      sameSiteAs: "acmeclinic.com",
      fetchImpl: impl,
      resolver: PUBLIC,
      maxRedirects: 2,
    });
    expect(res).toBeUndefined();
  });

  it("returns undefined rather than throwing when the network fails", async () => {
    const impl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      safeGet("https://acmeclinic.com/x", { fetchImpl: impl, resolver: PUBLIC }),
    ).resolves.toBeUndefined();
  });
});
