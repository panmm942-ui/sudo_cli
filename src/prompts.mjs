export function createPromptQueue({ question }) {
  let tail = Promise.resolve();
  let closed = false;
  const waiting = new Set();
  const aborted = () => new DOMException('The prompt was aborted.', 'AbortError');
  const cancel = () => { for (const controller of waiting) controller.abort(); };
  return {
    ask(prompt, hidden = false) {
      if (closed) return Promise.reject(new Error('Prompt interface is closed.'));
      const controller = new AbortController();
      waiting.add(controller);
      const result = tail.then(() => {
        if (controller.signal.aborted) throw aborted();
        return question(prompt, { signal: controller.signal, hidden });
      }).finally(() => waiting.delete(controller));
      tail = result.catch(() => {});
      return result;
    },
    cancel,
    close() { closed = true; cancel(); },
  };
}
