/** Outbound email message. Bodies may contain one-time links and must never be logged. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Machine-readable template identifier, safe to log. */
  template: string;
}

/** Provider abstraction for outbound email (real providers are added in later phases). */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Development/test provider: records messages in memory instead of delivering them.
 * Deliberately never logs message bodies (they contain password-reset and invitation links).
 */
export class MockEmailProvider implements EmailProvider {
  readonly sent: (EmailMessage & { from: string; sentAt: Date })[] = [];

  constructor(
    private readonly from: string,
    private readonly maxStored = 500,
  ) {}

  send(message: EmailMessage): Promise<void> {
    this.sent.push({ ...message, from: this.from, sentAt: new Date() });
    if (this.sent.length > this.maxStored) this.sent.shift();
    return Promise.resolve();
  }

  /** Test/dev helper: most recent message sent to an address. */
  lastTo(address: string): (EmailMessage & { from: string; sentAt: Date }) | undefined {
    const normalized = address.trim().toLowerCase();
    return this.sent.findLast((m) => m.to.trim().toLowerCase() === normalized);
  }
}
