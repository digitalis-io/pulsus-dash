// Stub for the tests-first commit: the implementation follows.
/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export type TimeUnit = 's' | 'm' | 'h' | 'd' | 'w';

export type TimeExpr =
  | {
      kind: 'now';
    }
  | {
      kind: 'startOfDay';
    }
  | {
      kind: 'ago';
      n: number;
      unit: TimeUnit;
    }
  | {
      kind: 'absolute';
      ms: number;
    };

export type TimeExprError =
  | {
      code: 'empty';
    }
  | {
      code: 'syntax';
    }
  | {
      code: 'badNumber';
    }
  | {
      code: 'outOfRange';
    }
  | {
      code: 'unknownUnit';
      unit: string;
    };

export type ParseResult =
  | {
      ok: true;
      expr: TimeExpr;
    }
  | {
      ok: false;
      error: TimeExprError;
    };

export const UNIT_MS: Readonly<Record<TimeUnit, number>> = notImplemented();

export function parseTimeExpr(s: string): ParseResult {
  throw new Error('not implemented');
}

export function printTimeExpr(e: TimeExpr): string {
  throw new Error('not implemented');
}

export function resolveTimeExpr(e: TimeExpr, nowMs: number, timeZone: string): number {
  throw new Error('not implemented');
}

export function isAbsolute(s: string): boolean {
  throw new Error('not implemented');
}

export function resolveTimeString(s: string, nowMs: number, timeZone: string): number {
  throw new Error('not implemented');
}

export function timeExprErrorMessage(e: TimeExprError): string {
  throw new Error('not implemented');
}
