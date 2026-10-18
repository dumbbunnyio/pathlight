import { Effect, Schema } from "effect";

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  operation: Schema.String, message: Schema.String, cause: Schema.Defect(),
}) {}

export const failure = (operation: string, cause: unknown) => new OperationError({
  operation, cause, message: cause instanceof Error ? cause.message : String(cause),
});

export const io = <A>(operation: string, body: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: body, catch: cause => failure(operation, cause) });

export const attempt = <A>(operation: string, body: () => A) =>
  Effect.try({ try: body, catch: cause => failure(operation, cause) });

export function hasCode(error: unknown, code: string): boolean {
  if (error instanceof OperationError) return hasCode(error.cause, code);
  return error instanceof Error && "code" in error && error.code === code;
}

export const json = (text: string) => attempt("JSON.decode", (): unknown => JSON.parse(text));
