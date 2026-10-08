// Exact artwork and pulse algorithm supplied by the user. Only wave colors vary.
export const ANTENNA_ART = `⠀⠀⠀⢠⡄⠀⠀⣠⡄⠀⠀⣠⠄⠀⠀⠀⠀⠠⣄⠀⠀⢠⣄⠀⠀⢠⡄⠀⠀⠀
⠀⠀⠀⢸⠀⠀⠀⣿⠀⠀⠀⡟⠀⢠⣶⣶⡄⠀⢻⠀⠀⠀⣿⠀⠀⠀⡇⠀⠀⠀
⠀⠀⠀⢸⡀⠀⠀⣿⡀⠀⠀⣷⠀⠈⠛⠛⠁⠀⣾⠀⠀⢀⣿⠀⠀⢀⡇⠀⠀⠀
⠀⠀⠀⠘⣇⠀⠀⠘⣷⡀⠀⠈⠃⣸⡇⢸⣇⠘⠁⠀⢀⣾⠃⠀⠀⣸⠃⠀⠀⠀
⠀⠀⠀⠀⠹⣆⠀⠀⠘⢿⡄⠀⢠⡿⠀⠀⢿⡄⠀⢠⡿⠃⠀⠀⣰⠏⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠙⢧⣄⠀⠀⠀⠀⣾⠃⠀⠀⠘⣷⠀⠀⠀⠀⣠⡼⠋⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠙⠷⡀⠀⢸⡏⠀⠀⠀⠀⢹⡇⠀⢀⠾⠋⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣾⠀⠀⠀⠀⠀⠀⣷⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⡟⣛⣷⣶⣶⣾⣛⢻⣇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⢿⣯⣍⣀⣀⣩⣽⡿⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣇⣤⣴⠿⠛⠛⠿⣦⣤⣸⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⢰⡟⠿⠷⣦⣤⣤⣤⣤⣴⠾⠿⢻⡆⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⢀⣿⡷⠶⠟⠛⠋⠉⠉⠙⠛⠻⠶⢾⣿⡀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⣼⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣧⠀⠀⠀⠀⠀⠀⠀`;
export const ANTENNA_ROWS = ANTENNA_ART.split('\n');
export const WIDTH = 30, FPS = 30, PERIOD = 1.5, DELAY = 0.20;
export const PALETTE = Object.freeze({ background: [11,15,20], tower: [220,227,235], inactive: [221,189,184], active: [198,40,40], peak: [239,41,41] });
export const foreground = rgb => `\x1b[38;2;${rgb.join(';')}m`;
export const BACKGROUND_STYLE = `\x1b[48;2;${PALETTE.background.join(';')}m`;
export const TOWER_STYLE = foreground(PALETTE.tower);
export const PEAK_STYLE = foreground(PALETTE.peak);
export const INACTIVE_STYLE = foreground(PALETTE.inactive);
const LEFT_WAVES = [
  {0:[11,12],1:[11],2:[11],3:[11,12]},
  {0:[7,8],1:[7],2:[7,8],3:[7,8,9],4:[8,9,10]},
  {0:[3,4],1:[3],2:[3,4],3:[3,4],4:[4,5],5:[5,6,7],6:[7,8,9]},
];
const waves = new Map();
LEFT_WAVES.forEach((cells, ring) => Object.entries(cells).forEach(([y, columns]) => columns.forEach(x => {
  waves.set(`${y},${x}`, ring); waves.set(`${y},${WIDTH-1-x}`, ring);
})));
// Python round() uses nearest even at an exact tie.
const round = value => { const floor = Math.floor(value); return value - floor === .5 ? floor % 2 ? floor + 1 : floor : Math.round(value); };
const blend = (start, end, amount) => start.map((a, i) => round(a + (end[i]-a)*amount));

export function renderAntenna({ elapsed = 0, color = true, idle = false } = {}) {
  if (!color) return [...ANTENNA_ROWS];
  const colors = LEFT_WAVES.map((_, ring) => {
    const phase = 2 * Math.PI * (elapsed-ring*DELAY)/PERIOD;
    const intensity = idle ? 0 : ((1+Math.cos(phase))/2)**5;
    return foreground(intensity <= .75 ? blend(PALETTE.inactive, PALETTE.active, intensity/.75) : blend(PALETTE.active, PALETTE.peak, (intensity-.75)/.25));
  });
  return ANTENNA_ROWS.map((row, y) => BACKGROUND_STYLE + TOWER_STYLE + [...row].map((character, x) => {
    const ring = waves.get(`${y},${x}`);
    return ring === undefined ? character : colors[ring] + character + TOWER_STYLE;
  }).join(''));
}

export function createAntennaClock({ now = () => performance.now() } = {}) {
  let accumulated = 0, started = null, worked = false;
  return {
    elapsed(working) {
      const tick = now();
      if (working) { worked = true; if (started === null) started = tick; }
      else if (started !== null) { accumulated += Math.max(0, tick-started); started = null; }
      return (accumulated + (started === null ? 0 : Math.max(0, tick-started)))/1000;
    },
    hasWorked() { return worked; },
  };
}
