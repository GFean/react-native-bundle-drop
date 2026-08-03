export class ExpoIntegrationError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ExpoIntegrationError';
    this.cause = options?.cause;
  }
}
