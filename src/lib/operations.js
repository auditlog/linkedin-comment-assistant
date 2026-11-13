// Ownership is checked after every await and in streaming callbacks. Aborting alone
// is insufficient: an old finally/catch must not mutate a newer operation's UI.
export function abortError() {
  return new DOMException('Przerwano.', 'AbortError');
}

export function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export class Operations {
  constructor(onChange = () => {}) {
    this.tasks = new Map();
    this.onChange = onChange;
  }

  start(name, label, scope = 'post') {
    this.tasks.get(name)?.controller.abort();
    const task = { name, label, scope, controller: new AbortController(), startedAt: Date.now() };
    task.signal = task.controller.signal;
    task.owns = () => this.tasks.get(name) === task;
    task.current = () => task.owns() && !task.signal.aborted;
    this.tasks.set(name, task);
    this.onChange({ type: 'start', task });
    return task;
  }

  finish(task) {
    if (task.owns()) this.tasks.delete(task.name);
    this.onChange();
  }

  has(name) {
    const task = this.tasks.get(name);
    return Boolean(task && !task.signal.aborted);
  }

  cancel(name) {
    this.tasks.get(name)?.controller.abort();
    this.onChange();
  }

  cancelAll({ scope, discard = false } = {}) {
    for (const [name, task] of this.tasks) {
      if (scope && task.scope !== scope) continue;
      task.controller.abort();
      if (discard) this.tasks.delete(name);
    }
    this.onChange();
  }

  active() {
    return [...this.tasks.values()].filter((task) => !task.signal.aborted);
  }
}
