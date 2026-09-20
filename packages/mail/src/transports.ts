import type { MailTransport, OutboundMessage, SendResult } from "./types.js";

/** Kept in memory. Tests assert on what was sent; nothing leaves the process. */
export class MemoryTransport implements MailTransport {
  readonly name = "memory";
  readonly sent: OutboundMessage[] = [];
  /** Set to make the next send fail, to exercise the failure path. */
  failNext: Error | null = null;

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.sent.push(message);
    return { id: `mem_${this.sent.length}`, via: this.name };
  }

  last(): OutboundMessage | undefined { return this.sent.at(-1); }
  clear(): void { this.sent.length = 0; }
}

/**
 * Development: print the message to the server log instead of sending it.
 *
 * The full text part is printed, not a summary — the point of this transport
 * is that a developer with no mail provider can complete a real sign-in by
 * reading the link out of their terminal.
 */
export class ConsoleTransport implements MailTransport {
  readonly name = "console";
  constructor(private readonly write: (line: string) => void = console.info) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    this.write(
      `\n──────── mail (not sent: no provider configured) ────────\n` +
        `to:      ${message.to}\n` +
        `subject: ${message.subject}\n\n` +
        `${message.text}\n` +
        `─────────────────────────────────────────────────────────\n`,
    );
    return { id: null, via: this.name };
  }
}

export interface ResendOptions {
  apiKey: string;
  /** e.g. `GitLit <hello@gitlit.app>` — the domain must be verified at Resend. */
  from: string;
  replyTo?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const TIMEOUT_MS = 10_000;

/**
 * Resend over its REST API rather than the `resend` SDK.
 *
 * One POST with a JSON body is the whole integration. A dependency that wraps
 * it would add a package to audit and upgrade, and would make the transport
 * harder to test than injecting `fetch` is.
 */
export class ResendTransport implements MailTransport {
  readonly name = "resend";
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly endpoint: string;

  constructor(private readonly options: ResendOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? "https://api.resend.com/emails";
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const payload = {
      from: this.options.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: [{ name: "kind", value: message.tag }],
      ...(this.options.replyTo ? { reply_to: this.options.replyTo } : {}),
    };

    // Two attempts, not more. A sign-in link is worth one retry past a blip;
    // past that the author is better served by an honest error and a button
    // to try again than by a request that hangs while we keep hoping.
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as { id?: string };
          return { id: body.id ?? null, via: this.name };
        }

        const detail = (await res.text().catch(() => "")).slice(0, 500);
        lastError = new Error(`resend ${res.status}: ${detail}`);
        // A rejected address or an unverified sending domain will be rejected
        // identically next time; only retry what can plausibly change.
        if (!RETRYABLE.has(res.status)) break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error("resend: send failed");
  }
}
