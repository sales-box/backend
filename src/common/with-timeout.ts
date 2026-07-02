/** Rejects if the promise does not settle within the given number of ms. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Operation timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
