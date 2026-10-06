/** Two tiny sounds, made on the spot with WebAudio. No audio files to ship,
 * cache or licence. Quiet by design: a cue, not an alarm. */

type Ctx = AudioContext;
let ctx: Ctx | null = null;

function audio(): Ctx | null {
  if (ctx) return ctx;
  const Make = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Make) return null;
  try { ctx = new Make(); } catch { ctx = null; }
  return ctx;
}

function tone(c: Ctx, freq: number, start: number, length: number, peak: number, type: OscillatorType) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

function play(volume: number, notes: [freq: number, at: number, length: number][], type: OscillatorType) {
  const c = audio();
  if (!c || volume <= 0) return;
  try {
    if (c.state === "suspended") void c.resume();
    const peak = 0.25 * (volume / 100);
    const now = c.currentTime;
    for (const [f, at, len] of notes) tone(c, f, now + at, len, peak, type);
  } catch { /* a browser that will not play is fine */ }
}

/** Something arrived: two short square-ish beeps, like a reversing truck. */
export function playBeep(volume: number) {
  play(volume, [[880, 0, 0.12], [880, 0.2, 0.12]], "triangle");
}

/** Something shipped: a bright two-note ding. */
export function playDing(volume: number) {
  play(volume, [[1318.5, 0, 0.5], [1760, 0.12, 0.7]], "sine");
}
