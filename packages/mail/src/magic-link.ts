import { button, escapeHtml, layout, paragraph } from "./layout.js";
import type { OutboundMessage } from "./types.js";

export interface MagicLinkMail {
  to: string;
  /** The single-use `glm_…` token. */
  token: string;
  /** Origin of the web app, e.g. https://gitlit.app — no trailing slash. */
  webUrl: string;
  /** How long the link is good for, in minutes. */
  expiresInMinutes: number;
}

/**
 * The sign-in email.
 *
 * The link is a GET that lands on a page; the page then POSTs the token to
 * consume it. That split is not ceremony. Corporate mail gateways and
 * link-preview bots fetch every URL in an inbound message before the reader
 * ever sees it, so a magic link that signs you in on GET is spent by the
 * scanner and the author is told their link is invalid — every time, with no
 * way to tell why. A GET that only renders is safe to prefetch.
 */
export function magicLinkMail({ to, token, webUrl, expiresInMinutes }: MagicLinkMail): OutboundMessage {
  const url = `${webUrl.replace(/\/+$/, "")}/signin?token=${encodeURIComponent(token)}`;
  const validity = `${expiresInMinutes} minute${expiresInMinutes === 1 ? "" : "s"}`;

  const html = layout({
    preheader: `Your GitLit sign-in link — good for ${validity}, once.`,
    heading: "Sign in to GitLit",
    body: [
      paragraph("Use this link to sign in. There is no password to remember."),
      button(url, "Sign in to GitLit"),
      paragraph(
        `It works once and expires in ${escapeHtml(validity)}.`,
        true,
      ),
      paragraph(
        "If the button does not work, copy this address into your browser:<br>" +
          `<span style="word-break:break-all;">${escapeHtml(url)}</span>`,
        true,
      ),
      paragraph(
        "If you did not ask to sign in, you can ignore this email — the link " +
          "is useless without your inbox, and nothing has changed on your account.",
        true,
      ),
    ],
  });

  const text = [
    "Sign in to GitLit",
    "",
    "Use this link to sign in. There is no password to remember.",
    "",
    url,
    "",
    `It works once and expires in ${validity}.`,
    "",
    "If you did not ask to sign in, you can ignore this email — the link is",
    "useless without your inbox, and nothing has changed on your account.",
    "",
    "— GitLit",
  ].join("\n");

  return { to, subject: "Your GitLit sign-in link", html, text, tag: "magic-link" };
}
