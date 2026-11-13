/** IPC can arrive before spawn resolves. Replay those first frames when a listener attaches. */
export function bufferedChannel<T>() {
  const listeners: Array<(value: T) => void> = [];
  const pending: T[] = [];
  return {
    emit(value: T) {
      if (listeners.length) listeners.forEach((cb) => cb(value));
      else { pending.push(value); if (pending.length > 256) pending.shift(); }
    },
    on(cb: (value: T) => void) {
      listeners.push(cb);
      for (const value of pending.splice(0)) cb(value);
    },
  };
}
