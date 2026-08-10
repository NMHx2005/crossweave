export class CrossweaveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CrossweaveError';
    this.code = code;
  }
}
