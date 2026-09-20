import { describe, expect, it, vi } from "vitest";
import { escapeHtml } from "./layout.js";
import { magicLinkMail } from "./magic-link.js";
import { ConsoleTransport, MemoryTransport, ResendTransport } from "./transports.js";
import { Mailer, createMailer } from "./mailer.js";

const TOKEN = "glm_0123456789abcdef01_" + "a".repeat(64);

describe("the magic-link email", () => {
  const mail = magicLinkMail({
    to: "author@example.com",
    token: TOKEN,
    webUrl: "https://gitlit.app",
    expiresInMinutes: 15,
  });

  it("points at the web app's sign-in page, not the API", () => {
    expect(mail.html).toContain("https://gitlit.app/signin?token=");
    expect(mail.text).toContain("https://gitlit.app/signin?token=");
  });

  it("carries the token in the link", () => {
    expect(mail.text).toContain(TOKEN);
  });

  it("trims a trailing slash rather than emitting a double slash", () => {
    const m = magicLinkMail({ to: "a@b.co", token: TOKEN, webUrl: "https://gitlit.app/", expiresInMinutes: 15 });
    expect(m.text).toContain("https://gitlit.app/signin?");
    expect(m.text).not.toContain("gitlit.app//signin");
  });

  it("always has a text part — a link-only HTML mail scores as spam", () => {
    expect(mail.text.length).toBeGreaterThan(80);
    expect(mail.html).toContain("<!doctype html>");
  });

  it("says how long the link lasts, and that it is single use", () => {
    expect(mail.text).toContain("15 minutes");
    expect(mail.text).toContain("once");
  });

  it("singularises one minute", () => {
    const m = magicLinkMail({ to: "a@b.co", token: TOKEN, webUrl: "https://x.test", expiresInMinutes: 1 });
    expect(m.text).toContain("1 minute.");
  });

  it("tells a recipient who did not ask for it that they can ignore it", () => {
    expect(mail.text).toMatch(/did not ask/i);
  });

  it("is tagged so delivery problems can be traced by kind", () => {
    expect(mail.tag).toBe("magic-link");
  });
});

describe("escaping", () => {
  it("escapes quotes, so a value cannot break out of an attribute", () => {
    expect(escapeHtml(`" onload="alert(1)`)).not.toContain(`"`);
  });

  it("escapes a url that has been given script content", () => {
    const m = magicLinkMail({
      to: "a@b.co",
      token: TOKEN,
      webUrl: `https://x.test"><script>alert(1)</script>`,
      expiresInMinutes: 15,
    });
    expect(m.html).not.toContain("<script>");
  });
});

describe("the Resend transport", () => {
  const ok = () => new Response(JSON.stringify({ id: "re_123" }), { status: 200 });

  it("posts the message and returns the provider id", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const t = new ResendTransport({
      apiKey: "re_key", from: "GitLit <hi@gitlit.app>", fetch: fetchImpl as unknown as typeof fetch,
    });
    const result = await t.send({ to: "a@b.co", subject: "s", html: "<p>h</p>", text: "t", tag: "magic-link" });

    expect(result).toEqual({ id: "re_123", via: "resend" });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toBe("GitLit <hi@gitlit.app>");
    expect(body.to).toEqual(["a@b.co"]);
    expect(body.text).toBe("t");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
  });

  it("omits reply_to unless one is configured", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const t = new ResendTransport({ apiKey: "k", from: "a@b.co", fetch: fetchImpl as unknown as typeof fetch });
    await t.send({ to: "x@y.co", subject: "s", html: "h", text: "t", tag: "k" });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("reply_to");
  });

  it("retries a 429 and succeeds on the second attempt", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(ok());
    const t = new ResendTransport({ apiKey: "k", from: "a@b.co", fetch: fetchImpl as unknown as typeof fetch });
    await expect(t.send({ to: "x@y.co", subject: "s", html: "h", text: "t", tag: "k" }))
      .resolves.toMatchObject({ id: "re_123" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 422 — an unverified domain fails the same way twice", async () => {
    const fetchImpl = vi.fn(async () => new Response("domain not verified", { status: 422 }));
    const t = new ResendTransport({ apiKey: "k", from: "a@b.co", fetch: fetchImpl as unknown as typeof fetch });
    await expect(t.send({ to: "x@y.co", subject: "s", html: "h", text: "t", tag: "k" }))
      .rejects.toThrow(/422/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the provider's own message, so the cause is in the log", async () => {
    const fetchImpl = vi.fn(async () => new Response("The gitlit.app domain is not verified", { status: 403 }));
    const t = new ResendTransport({ apiKey: "k", from: "a@b.co", fetch: fetchImpl as unknown as typeof fetch });
    await expect(t.send({ to: "x@y.co", subject: "s", html: "h", text: "t", tag: "k" }))
      .rejects.toThrow(/not verified/);
  });
});

describe("the console transport", () => {
  it("prints the whole text part, so a developer can finish a real sign-in", async () => {
    const lines: string[] = [];
    const t = new ConsoleTransport((l) => lines.push(l));
    const mail = magicLinkMail({ to: "a@b.co", token: TOKEN, webUrl: "http://localhost:3000", expiresInMinutes: 15 });
    await t.send(mail);
    expect(lines.join("\n")).toContain(TOKEN);
  });
});

describe("choosing a transport", () => {
  it("refuses to start in production with no provider", () => {
    expect(() => createMailer({ NODE_ENV: "production" }))
      .toThrow(/RESEND_API_KEY must be set in production/);
  });

  it("refuses a provider key with no from address", () => {
    expect(() => createMailer({ NODE_ENV: "production", RESEND_API_KEY: "re_k" }))
      .toThrow(/MAIL_FROM/);
  });

  it("refuses a MAIL_FROM that is not an address", () => {
    expect(() => createMailer({ NODE_ENV: "production", RESEND_API_KEY: "re_k", MAIL_FROM: "gitlit.app" }))
      .toThrow(/must be an email address/);
  });

  it("uses Resend when configured", () => {
    const m = createMailer({ NODE_ENV: "production", RESEND_API_KEY: "re_k", MAIL_FROM: "a@b.co" });
    expect(m.transportName).toBe("resend");
  });

  it("falls back to the console in development, loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = createMailer({ NODE_ENV: "development" });
    expect(m.transportName).toBe("console");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("RESEND_API_KEY is unset"));
    warn.mockRestore();
  });

  it("never sends anywhere under test", () => {
    expect(createMailer({ NODE_ENV: "test" }).transportName).toBe("memory");
  });
});

describe("the mailer", () => {
  it("builds the link from the configured web url", async () => {
    const transport = new MemoryTransport();
    await new Mailer({ transport, webUrl: "https://write.example" }).sendMagicLink("a@b.co", TOKEN, 15);
    expect(transport.last()!.text).toContain("https://write.example/signin?token=");
    expect(transport.last()!.to).toBe("a@b.co");
  });

  it("propagates a transport failure rather than reporting success", async () => {
    const transport = new MemoryTransport();
    transport.failNext = new Error("provider down");
    await expect(new Mailer({ transport, webUrl: "https://x.test" }).sendMagicLink("a@b.co", TOKEN, 15))
      .rejects.toThrow("provider down");
    expect(transport.sent).toHaveLength(0);
  });
});
