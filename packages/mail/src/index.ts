export type { MailTransport, OutboundMessage, SendResult } from "./types.js";
export { escapeHtml } from "./layout.js";
export { magicLinkMail, type MagicLinkMail } from "./magic-link.js";
export { ConsoleTransport, MemoryTransport, ResendTransport, type ResendOptions } from "./transports.js";
export { Mailer, createMailer, type MailerConfig, type MailerEnv } from "./mailer.js";
