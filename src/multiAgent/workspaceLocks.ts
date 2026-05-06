const fileLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousLock = fileLocks.get(filePath) ?? Promise.resolve();
  let releaseCurrentLock: () => void = () => {};
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });

  const chainedLock = previousLock.then(() => currentLock);
  fileLocks.set(filePath, chainedLock);

  await previousLock;

  try {
    return await operation();
  } finally {
    releaseCurrentLock();

    if (fileLocks.get(filePath) === chainedLock) {
      fileLocks.delete(filePath);
    }
  }
}
