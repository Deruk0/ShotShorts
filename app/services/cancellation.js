function createAbortError(message = 'Cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ERR_ABORTED';
  return err;
}

function isAbortError(err) {
  if (!err) return false;
  return (
    err.name === 'AbortError' ||
    err.code === 'ERR_ABORTED' ||
    err.code === 'ERR_CANCELED' ||
    err.code === 'ABORT_ERR' ||
    /cancelled|canceled|aborted/i.test(String(err.message || ''))
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function onAbort(signal, callback) {
  if (!signal) return () => {};
  if (signal.aborted) {
    callback();
    return () => {};
  }

  signal.addEventListener('abort', callback, { once: true });
  return () => signal.removeEventListener('abort', callback);
}

function abortableSleep(ms, signal) {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const cleanup = onAbort(signal, () => {
      clearTimeout(timer);
      reject(createAbortError());
    });
  });
}

function formatFfmpegError(err, stdout, stderr, fallbackPrefix = 'FFmpeg failed') {
  const message = err?.message || fallbackPrefix;
  return new Error(message + (stderr ? `\nstderr: ${stderr}` : ''));
}

function runFfmpegCommand(cmd, {
  signal,
  onStart,
  formatError = formatFfmpegError
} = {}) {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    let removeAbortHandler = () => {};

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      removeAbortHandler();
      fn();
    };

    removeAbortHandler = onAbort(signal, () => {
      try { cmd.kill('SIGKILL'); } catch {}
      finish(() => reject(createAbortError()));
    });

    try {
      onStart?.(cmd);
      cmd
        .on('end', () => finish(resolve))
        .on('error', (err, stdout, stderr) => {
          finish(() => reject(isAbortError(err) || signal?.aborted
            ? createAbortError()
            : formatError(err, stdout, stderr)));
        })
        .run();
    } catch (err) {
      finish(() => reject(signal?.aborted ? createAbortError() : err));
    }
  });
}

module.exports = {
  abortableSleep,
  createAbortError,
  isAbortError,
  onAbort,
  runFfmpegCommand,
  throwIfAborted
};
