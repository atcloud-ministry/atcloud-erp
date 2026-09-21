/** Await a promise-like value while enforcing an AbortSignal deadline. */
export function awaitWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Operation aborted."));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new Error("Operation aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
