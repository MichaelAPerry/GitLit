/**
 * Outbound mail (§4, "Email | Resend + React Email").
 *
 * Every GitLit email is transactional and addressed to one person: a sign-in
 * link, later an invite or a publisher verification link. There is no bulk
 * send here and there is not meant to be, which is why there is no list id,
 * no unsubscribe machinery, and no template variables an operator can set.
 */
export interface OutboundMessage {
  to: string;
  subject: string;
  /**
   * Both parts are always present. A text/plain alternative is not a courtesy
   * to old clients: a message with no text part scores worse with spam
   * filters, and a sign-in link that lands in spam is the same outage as a
   * link that was never sent.
   */
  html: string;
  text: string;
  /** Stable per message kind, so delivery problems can be traced by category. */
  tag: string;
}

export interface SendResult {
  /** Provider-assigned id where there is one, for matching against their log. */
  id: string | null;
  /** Which transport handled it — "resend", "console", "memory". */
  via: string;
}

export interface MailTransport {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}
