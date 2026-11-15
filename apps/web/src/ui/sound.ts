/**
 * Sound, generated with Web Audio: no audio files. Off by default; this
 * module is only imported the first time sound is switched on, which is also
 * a user gesture, so the AudioContext is allowed to start.
 *
 * A soft tick answers selections and layer toggles. The optional hum is two
 * low sines a fifth apart, breathing slowly, far below the tick in level.
 */

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

let context: AudioContext | null = null;
let master: GainNode | null = null;
let hum: { gain: GainNode; stop(): void } | null = null;

function ensure(): AudioContext | null {
  if (context) return context;
  const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  master = context.createGain();
  master.gain.value = 0;
  master.connect(context.destination);
  return context;
}

/** Switch all sound on or off. Fades, never clicks. */
export function setEnabled(on: boolean): void {
  const ctx = on ? ensure() : context;
  if (!ctx || !master) return;
  if (on) void ctx.resume();
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setTargetAtTime(on ? 1 : 0, now, 0.05);
  if (!on) {
    // Let the fade finish, then stop the clock so a silent tab costs nothing.
    window.setTimeout(() => {
      if (master && master.gain.value < 0.01) void ctx.suspend();
    }, 400);
  }
}

/** A soft tick. `pitch` shifts it: selections sit a little above layer toggles. */
export function tick(pitch: "select" | "toggle" = "select"): void {
  const ctx = context;
  if (!ctx || !master || ctx.state !== "running") return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = pitch === "select" ? 1320 : 990;
  osc.type = "sine";
  osc.frequency.setValueAtTime(start, now);
  osc.frequency.exponentialRampToValueAtTime(start * 0.72, now + 0.05);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
  osc.connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + 0.08);
}

/** Start or stop the ambient hum. It only sounds while sound as a whole is on. */
export function setHum(on: boolean): void {
  const ctx = context;
  if (!ctx || !master) return;
  const now = ctx.currentTime;
  if (!on) {
    if (!hum) return;
    const ending = hum;
    hum = null;
    ending.gain.gain.setTargetAtTime(0, now, 0.4);
    window.setTimeout(() => ending.stop(), 2500);
    return;
  }
  if (hum) return;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 260;
  const voices = [55, 82.5, 110.4].map((frequency, i) => {
    const osc = ctx.createOscillator();
    osc.type = i === 2 ? "triangle" : "sine";
    osc.frequency.value = frequency;
    osc.connect(filter);
    osc.start();
    return osc;
  });
  // A slow swell so the hum breathes instead of sitting as a flat tone.
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  lfo.frequency.value = 0.07;
  depth.gain.value = 0.006;
  lfo.connect(depth).connect(gain.gain);
  lfo.start();
  filter.connect(gain).connect(master);
  gain.gain.setTargetAtTime(0.022, now, 1.2);
  hum = {
    gain,
    stop() {
      for (const osc of voices) osc.stop();
      lfo.stop();
      gain.disconnect();
    },
  };
}
