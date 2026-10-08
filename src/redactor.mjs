const REDACTED = '[redacted]';
const highSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

function replacementMarker(keys) {
  // Brackets form barriers around the usual marker only when no key contains them.
  if (!keys.some((key) => REDACTED.includes(key) || /[\[\]]/.test(key))) return REDACTED;
  for (let code = 0x2588; code <= 0x10ffff; code++) {
    const character = String.fromCodePoint(code);
    if (!/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(character) && !keys.some((key) => key.includes(character))) return character;
  }
  throw new Error('Secret configuration cannot be safely displayed.');
}

/** Discard terminal sequences across chunks without buffering their arbitrary payloads. */
function createTerminalFilter() {
  let state = 'text';
  return {
    reset() { state = 'text'; },
    write(chunk) {
      const output = [];
      for (const character of String(chunk ?? '')) {
        const code = character.charCodeAt(0);
        let reprocess = true;
        while (reprocess) {
          reprocess = false;
          if (state === 'osc' || state === 'string') {
            if (code === 0x9c || (state === 'osc' && code === 0x07)) state = 'text';
            else if (code === 0x1b) state += 'Escape';
          } else if (state === 'oscEscape' || state === 'stringEscape') {
            if (character === '\\' || code === 0x9c || (state === 'oscEscape' && code === 0x07)) state = 'text';
            else if (code !== 0x1b) state = state === 'oscEscape' ? 'osc' : 'string';
          } else if (state === 'escape') {
            if (character === '[') state = 'csi';
            else if (character === ']') state = 'osc';
            else if ('PX^_'.includes(character)) state = 'string';
            else if (code >= 0x20 && code <= 0x2f) state = 'escapeIntermediate';
            else if (code >= 0x30 && code <= 0x7e) state = 'text';
            else if (code !== 0x1b) { state = 'text'; reprocess = true; }
          } else if (state === 'escapeIntermediate') {
            if (code >= 0x30 && code <= 0x7e) state = 'text';
            else if (code === 0x1b) state = 'escape';
            else if (code < 0x20 || code > 0x2f) { state = 'text'; reprocess = true; }
          } else if (state === 'csi') {
            if (code >= 0x40 && code <= 0x7e) state = 'text';
            else if (code === 0x1b) state = 'escape';
            else if (code > 0x7e) { state = 'text'; reprocess = true; }
          } else if (code === 0x1b) state = 'escape';
          else if (code === 0x9b) state = 'csi';
          else if (code === 0x9d) state = 'osc';
          else if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) state = 'string';
          else if (code === 0x09 || code === 0x0a || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) output.push(character);
        }
      }
      return output.join('');
    },
  };
}

/** A turn-scoped output filter. Call flush at the end of a turn and reset before another. */
export function createRedactor({ secrets = () => [] } = {}) {
  const terminal = createTerminalFilter();
  let pending = '';

  function currentKeys() {
    const keys = secrets();
    return [...new Set((Array.isArray(keys) ? keys : [])
      .filter((key) => typeof key === 'string' && key.length)
      .map((key) => createTerminalFilter().write(key).toWellFormed()).filter(Boolean))]
      .sort((left, right) => right.length - left.length);
  }

  function emit(final) {
    // Keep a possible split pair intact, but repair other malformed Unicode before matching.
    const trailingHigh = !final && highSurrogate(pending.charCodeAt(pending.length - 1));
    pending = trailingHigh ? pending.slice(0, -1).toWellFormed() + pending.at(-1) : pending.toWellFormed();
    const keys = currentKeys();
    const marker = replacementMarker(keys);
    const hold = keys.length ? keys[0].length - 1 : 0;
    let limit = final ? pending.length : Math.max(0, pending.length - hold);
    if (!final && limit > 0 && highSurrogate(pending.charCodeAt(limit - 1))
      && (limit === pending.length || lowSurrogate(pending.charCodeAt(limit)))) limit--;
    const output = [];
    let position = 0;
    while (position < limit) {
      const key = keys.find((candidate) => pending.startsWith(candidate, position));
      if (key) {
        output.push(marker);
        // Consume the full match, even if it extends into the retained tail.
        position += key.length;
      } else {
        const length = pending.codePointAt(position) > 0xffff ? 2 : 1;
        output.push(pending.slice(position, position + length));
        position += length;
      }
    }
    pending = pending.slice(position);
    return output.join('');
  }

  return {
    write(chunk) {
      pending += terminal.write(chunk);
      return emit(false);
    },
    flush() {
      const output = emit(true);
      terminal.reset();
      return output;
    },
    reset() {
      pending = '';
      terminal.reset();
    },
  };
}
