export type JGDINAErrorCode =
  | "INVALID_INPUT"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "ABORTED"
  | "INVALID_BACKEND_RESULT"
  | "NUMERICAL_FAILURE";

export type ValidationIssueCode =
  | "required"
  | "type"
  | "empty"
  | "rectangular"
  | "range"
  | "integer"
  | "length"
  | "unsupported"
  | "degenerate";

export interface ValidationIssue {
  readonly path: string;
  readonly code: ValidationIssueCode;
  readonly message: string;
}

export class JGDINAError extends Error {
  readonly code: JGDINAErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: JGDINAErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JGDINAError";
    this.code = code;
    this.details = details;
  }
}

export class InputValidationError extends JGDINAError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super("INVALID_INPUT", validationMessage(issues), { issues });
    this.name = "InputValidationError";
    this.issues = issues;
  }
}

export class ResourceLimitError extends JGDINAError {
  readonly limit: string;
  readonly actual: number;
  readonly maximum: number;

  constructor(limit: string, actual: number, maximum: number) {
    super(
      "RESOURCE_LIMIT_EXCEEDED",
      `Resource limit ${limit} exceeded: ${actual} > ${maximum}.`,
      { actual, limit, maximum },
    );
    this.name = "ResourceLimitError";
    this.limit = limit;
    this.actual = actual;
    this.maximum = maximum;
  }
}

export class FitAbortedError extends JGDINAError {
  constructor() {
    super("ABORTED", "jGDINA fitting was aborted.");
    this.name = "FitAbortedError";
  }
}

export class InvalidBackendResultError extends JGDINAError {
  constructor(message: string) {
    super("INVALID_BACKEND_RESULT", message);
    this.name = "InvalidBackendResultError";
  }
}

function validationMessage(issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) return "Invalid jGDINA input.";
  const suffix = issues.length === 1 ? "" : ` (+${issues.length - 1} more)`;
  return `Invalid jGDINA input at ${issues[0]?.path ?? "input"}: ${issues[0]?.message ?? "validation failed"}${suffix}`;
}
