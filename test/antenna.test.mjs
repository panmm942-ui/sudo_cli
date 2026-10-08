import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

test('antenna preserves all original characters and timing constants', async () => {
  const { ANTENNA_ART, ANTENNA_ROWS, FPS, PERIOD, DELAY, renderAntenna } = await import('../src/antenna.mjs');
  assert.equal(ANTENNA_ROWS.length, 14);
  assert.equal(FPS, 30); assert.equal(PERIOD, 1.5); assert.equal(DELAY, 0.20);
  assert.equal(stripVTControlCharacters(renderAntenna({ elapsed: 0 }).join('\n')), ANTENNA_ART);
  assert.equal(stripVTControlCharacters(renderAntenna({ elapsed: .6 }).join('\n')), ANTENNA_ART);
  assert.ok(ANTENNA_ROWS[1].includes('⢠⣶⣶⡄'));
});

test('signal coloring leaves the tower and central tip constant and pulses only wave cells', async () => {
  const { renderAntenna, TOWER_STYLE, BACKGROUND_STYLE, PEAK_STYLE, INACTIVE_STYLE } = await import('../src/antenna.mjs');
  const active = renderAntenna({ elapsed: 0 });
  const idle = renderAntenna({ elapsed: 0, idle: true });
  assert.ok(active[0].includes(PEAK_STYLE));
  assert.ok(idle[0].includes(INACTIVE_STYLE));
  assert.ok(active[1].includes(TOWER_STYLE));
  assert.ok(active[13].startsWith(BACKGROUND_STYLE + TOWER_STYLE));
  assert.equal(active[13], renderAntenna({ elapsed: .7 })[13]);
});

test('animation clock freezes between tasks and resumes without idle elapsed time', async () => {
  const { createAntennaClock } = await import('../src/antenna.mjs');
  let now = 0;
  const clock = createAntennaClock({ now: () => now });
  assert.equal(clock.elapsed(false), 0);
  clock.elapsed(true); now = 600;
  assert.equal(clock.elapsed(true), .6);
  clock.elapsed(false); now = 100000;
  assert.equal(clock.elapsed(false), .6);
  assert.equal(clock.elapsed(true), .6); now += 300;
  assert.equal(clock.elapsed(true), .9);
});
