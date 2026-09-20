import { magicLinkMail } from "./magic-link.js";
import { ConsoleTransport, MemoryTransport, ResendTransport } from "./transports.js";
import type { MailTransport, SendResult } from "./types.js";

export interface MailerConfig {
  transport: MailTransport;
  webUrl: string;
}

export class Mailer {
  constructor(private readonly config: MailerConfig) {}

  get transportName(): string { return this.config.transport.name; }

  /** The transport itself, so a test can read what was sent. */
  get transport(): MailTransport { return this.config.transport; }

  sendMagicLink(to: string, token: string, expiresInMinutes: number): Promise<SendResult> {
    return this.config.transport.send(
      magicLinkMail({ to, token, webUrl: this.config.webUrl, expiresInMinutes }),
    );
  }
}

export interface MailerEnv {
  NODE_ENV?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  MAIL_FROM?: string | undefined;
  MAIL_REPLY_TO?: string | undefined;
  PUBLIC_WEB_URL?: string | undefined;
}

/**
 * Choose a transport from the environment.
 *
 * In production this THROWS rather than falling back to the console. An API
 * that starts without a mail provider looks healthy, accepts sign-up requests,
 * answers "a link is on its way", and sends nothing — and the only person who
 * finds out is the author who cannot get in. That is worse than not starting.
 */
export function createMailer(env: MailerEnv = process.env): Mailer {
  const webUrl = env.PUBLIC_WEB_URL ?? "http://localhost:3000";

  if (env.NODE_ENV === "test") {
    return new Mailer({ transport: new MemoryTransport(), webUrl });
  }

  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();

  if (apiKey) {
    if (!from) {
      throw new Error(
        "RESEND_API_KEY is set but MAIL_FROM is not. Set MAIL_FROM to an address " +
          'on a domain verified at Resend, e.g. MAIL_FROM="GitLit <hello@gitlit.app>".',
      );
    }
    if (!/@/.test(from)) {
      throw new Error(`MAIL_FROM must be an email address, got ${JSON.stringify(from)}.`);
    }
    return new Mailer({
      transport: new ResendTransport({ apiKey, from, replyTo: env.MAIL_REPLY_TO?.trim() }),
      webUrl,
    });
  }

  if (env.NODE_ENV === "production") {
    throw new Error(
      "RESEND_API_KEY must be set in production — without it nobody can sign in " +
        "by email, and the sign-in page would say a link was sent when none was.",
    );
  }

  // eslint-disable-next-line no-console
  console.warn(
    "RESEND_API_KEY is unset — sign-in emails will be printed to this log " +
      "instead of sent. Fine for development; set it for anything else.",
  );
  return new Mailer({ transport: new ConsoleTransport(), webUrl });
}
