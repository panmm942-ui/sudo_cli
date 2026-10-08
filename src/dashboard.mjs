import { stripVTControlCharacters } from 'node:util';
import { basename } from 'node:path';
import { VERSION } from './version.mjs';
import { ANTENNA_ROWS, renderAntenna, createAntennaClock, BACKGROUND_STYLE, FPS } from './antenna.mjs';

const LOGO = [
  ' ____  _   _ ____   ___      ____ _     ___ ',
  '/ ___|| | | |  _ \\ / _ \\    / ___| |   |_ _|',
  '\\___ \\| | | | | | | | | |  | |   | |    | | ',
  ' ___) | |_| | |_| | |_| |  | |___| |___ | | ',
  '|____/ \\___/|____/ \\___/    \\____|_____|___|',
];
export const ART = LOGO.join('\r\n');
const LOGO_COLOR = '38;2;239;41;41';
const CREDITS = 'Credits: instagram.com/mimilidhcc/ | github.com/panmm942-ui';
const SHORT_CREDITS = 'Credits: @mimilidhcc | GitHub: panmm942-ui';

export function workedTime(milliseconds = 0) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}
const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/[\r\n\t]/g, ' ');
const cellWidth = character => {
  const code = character.codePointAt(0);
  if (/\p{Mark}/u.test(character)) return 0;
  return (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || code >= 0x20000)) ? 2 : 1;
};
const width = value => [...clean(value)].reduce((count, character) => count + cellWidth(character), 0);
function fit(value, columns) {
  const plain = clean(value);
  if (width(plain) <= columns) return plain;
  let result = '', count = 0;
  for (const character of plain) { const cells = cellWidth(character); if (count + cells > Math.max(0, columns - 1)) break; result += character; count += cells; }
  return columns > 0 ? result + '~' : '';
}

export function describeSystem({ platform = process.platform, arch = process.arch } = {}) {
  return `${({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' })[platform] || platform} (${arch})`;
}

const clockFormatters = new Map();
function clock(date, timeZone) {
  let formatter=clockFormatters.get(timeZone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short', numberingSystem: 'latn' });clockFormatters.set(timeZone,formatter);}
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

function contextText(context, columns) {
  if (context?.used == null) return context?.limit ? `Unknown / ${context.limit.toLocaleString('en-US')} tokens` : 'Unknown';
  const percentage = context.percent == null ? '?%' : `~${context.percent}%`;
  const numeric = value => value == null ? 'unknown' : value.toLocaleString('en-US');
  const full = `${percentage} ${numeric(context.used)}/${numeric(context.limit)} tokens`;
  if (full.length <= columns) return full;
  const compact = value => value == null ? '?' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return `${percentage} ${compact(context.used)}/${compact(context.limit)} tokens`;
}

export function trafficRate(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Measuring';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s']; let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${unit ? bytes.toFixed(1) : Math.round(bytes)} ${units[unit]}`;
}

export function renderDashboard({ state, columns = 100, rows = 24, color = false, now = new Date(), timeZone, platform = process.platform, arch = process.arch, activity = 'Idle', antennaElapsed = 0, antennaIdle = !state.working }) {
  columns = Math.max(1, Math.floor(columns || 80) - 1); rows = Math.max(1, Math.floor(rows || 24));
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m${BACKGROUND_STYLE}` : text;
  const logoWidth = Math.max(...LOGO.map(line => line.length));
  const big = columns >= logoWidth + 36 && rows >= LOGO.length + ANTENNA_ROWS.length + 9;
  const artWidth = Math.max(...ANTENNA_ROWS.map(line => line.length));
  const leftWidth = big ? logoWidth : artWidth;
  const beside = columns >= leftWidth + 36;
  const available = beside ? columns - leftWidth - 3 : columns;
  const field = (label, value, code = 37) => paint(90, `${label}: `) + paint(code, fit(value, Math.max(0, available - label.length - 2)));
  const quality = state.health?.percent;
  const qualityColor = quality == null ? 90 : quality > 70 ? 32 : quality > 50 ? '38;5;208' : 31;
  const qualityLabel = quality == null ? 'Not measured' : `${quality}% ${quality > 70 ? 'Good' : quality > 50 ? 'Fair' : 'Bad'}`;
  const latency = state.health?.latencyMs;
  const qualityText = qualityLabel + (latency == null ? '' : ` | ${(latency / 1000).toFixed(1)}s`) + (state.health?.pending ? ' waiting' : '');
  const fields = [
    field('Time', clock(now, timeZone)),
    field('Software System', describeSystem({ platform, arch })),
    field('Status', state.working ? 'Working' : 'Not Working', state.working ? 32 : 31),
    field('WiFi Connection', state.network?.wifi || 'Unknown', state.network?.wifi === 'Yes' ? 32 : state.network?.wifi === 'No' ? 31 : 90),
    ...(state.network?.wifi === 'Yes' ? [field('Download', `${trafficRate(state.network.downloadBps)} | Upload: ${trafficRate(state.network.uploadBps)}`)] : []),
    field('Connected AI', state.connectedAI || 'No AI connected'),
    field('AI Connection', qualityText, qualityColor),
    field('Context', contextText(state.context, available - 9)),
    field('Permissions', state.permissions === 'allow-everything' ? 'Allow Everything' : 'Ask', state.permissions === 'allow-everything' ? '38;5;208' : 37),
    field('Web Access', state.webAccess ? 'On' : 'Off', state.webAccess ? 32 : 90),
    field('Effort', state.effort || 'Provider default'),
    field('Worked', `${workedTime(state.worked?.sessionMs)} | In Total: ${workedTime(state.worked?.totalMs)}`),
    ...(state.chatTitle?[field('Chat',state.chatTitle)]:[]),
    ...(state.voice?[field('Voice',state.voice.status|| (state.voice.running?'Listening':'Off'),state.voice.running?32:90)]:[]),
    ...(state.agent?[field('24/7 Agent',state.agent.state||state.agent.phase||state.agent.status||'Idle')]:[]),
    field('Activity', activity),
    field('Project', basename(String(state.cwd || '').replace(/\\/g, '/')) || '/'),
  ];
  let lines;
  if (beside) {
    const antenna = renderAntenna({ elapsed: antennaElapsed, idle: antennaIdle, color });
    const left = big ? [...LOGO.map(line => paint(LOGO_COLOR, line)), '', ...antenna] : [paint(LOGO_COLOR, 'SUDO CLI'), ...antenna];
    lines = Array.from({ length: Math.max(left.length, fields.length) }, (_, index) => {
      const value = left[index] || '';
      return value + ' '.repeat(Math.max(0, leftWidth-width(value))) + '   ' + (fields[index] || '');
    });
    lines.push('');
  } else lines = [paint(LOGO_COLOR, 'SUDO CLI'), ...fields];
  lines.push(paint(90, fit(`v${VERSION} | / for commands | Connection: estimate | Context: reported`, columns)), paint(90, fit(columns >= CREDITS.length ? CREDITS : SHORT_CREDITS, columns)), paint(90, '-'.repeat(columns)));
  if (color) lines[0] = BACKGROUND_STYLE + lines[0];
  if (rows - lines.length < 4 || columns <= logoWidth) return { lines: [paint(LOGO_COLOR, fit('SUDO CLI | Enlarge terminal', columns))], height: 1, sticky: false };
  return { lines, height: lines.length, sticky: true };
}

/** A terminal-only header. It never reads or redraws secret input. */
export function createDashboard({ output = process.stdout, snapshot, now = () => new Date(), monotonic = () => performance.now(), timeZone, platform, arch, activity = () => 'Idle', color = output.isTTY && !process.env.NO_COLOR, env = process.env, tickMs = 1000/FPS, onResize = () => {} }) {
  let started = false, sticky = false, alternate = false, height = 0, last = '', timer, body = '';
  const antennaClock = createAntennaClock({ now: monotonic });
  const view = () => {
    const state = snapshot(), elapsed = antennaClock.elapsed(!!state.working);
    return renderDashboard({ state, columns: output.columns || 80, rows: output.rows || 24, color: color && !!output.isTTY && env.TERM !== 'dumb', now: now(), timeZone, platform, arch, activity: activity(), antennaElapsed: elapsed, antennaIdle: !antennaClock.hasWorked() });
  };
  const draw = (lines) => '\x1b[H' + lines.map(line => line + '\x1b[K').join('\r\n');
  function resize() {
    if (!started) return;
    const previousSticky = sticky;
    const current = view();
    sticky = !!output.isTTY && env.TERM !== 'dumb' && current.sticky;
    height = current.height; last = current.lines.join('\n');
    if (sticky) {
      output.write(`\x1b[r\x1b[2J\x1b[H${draw(current.lines)}\x1b[${height + 1};${output.rows || 24}r\x1b[${height + 1};1H`);
      const lines = stripVTControlCharacters(body).split('\n');
      const tail = [];
      for (const line of lines) {
        let piece = '', size = 0;
        for (const character of line) { const cells = cellWidth(character); if (size + cells >= (output.columns || 80)) { tail.push(piece); piece = ''; size = 0; } piece += character; size += cells; }
        tail.push(piece);
      }
      const visible = tail.slice(-Math.max(1, (output.rows || 24) - height - 3)).join('\n');
      if (visible) output.write(visible + '\n');
      onResize();
    } else { output.write((alternate ? '\x1b[r\x1b[2J\x1b[H' : previousSticky ? '\x1b[r' : '') + last + '\r\n'); onResize(); }
  }
  function refresh() {
    if (!started) return;
    const current = view(), next = current.lines.join('\n');
    if (!sticky) {
      // Legacy/tiny terminals get state changes without per-second output spam.
      const withoutTime = lines => lines.split('\n').filter(line => !/^(Time|Worked|Connection|Download):/.test(stripVTControlCharacters(line))).join('\n');
      if (withoutTime(next) !== withoutTime(last)) { last = next; output.write('\n' + next + '\n'); }
      return;
    }
    if (current.height !== height) return resize();
    if (next === last) return;
    last = next;
    output.write(`\x1b7\x1b[?25l${draw(current.lines)}\x1b8\x1b[?25h`);
  }
  return {
    start() {
      if (started) return;
      started = true;
      const current = view(); height = current.height; last = current.lines.join('\n');
      sticky = !!output.isTTY && env.TERM !== 'dumb' && current.sticky;
      alternate = !!output.isTTY && env.TERM !== 'dumb';
      if (alternate) output.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
      if (sticky) output.write(`${draw(current.lines)}\x1b[${height + 1};${output.rows || 24}r\x1b[${height + 1};1H`);
      else output.write(last + '\n');
      if (alternate) output.write('\x1b[?25h');
      output.on?.('resize', resize);
      if (output.isTTY && env.TERM !== 'dumb' && tickMs > 0) {
        const tick = () => {
          if (!started) return;
          const before = performance.now(); refresh();
          timer = setTimeout(tick, Math.max(0, tickMs - (performance.now() - before))); timer.unref?.();
        };
        timer = setTimeout(tick, tickMs); timer.unref?.();
      }
    },
    refresh,
    write(text) { const value = String(text); body = (body + value).slice(-65536); output.write(value); },
    stop() {
      if (!started) return;
      started = false; clearTimeout(timer); output.removeListener?.('resize', resize);
      if (alternate) output.write('\x1b[r\x1b[0m\x1b[?25h\x1b[?1049l');
      alternate = false;
    },
  };
}
