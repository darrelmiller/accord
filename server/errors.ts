export class AccordError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function requireValue(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new AccordError(status, message);
}
