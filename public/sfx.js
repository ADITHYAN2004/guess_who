// Tiny sound effects, synthesized with the Web Audio API (no audio files to download).
// Usage: sfx.play("flip"), sfx.setMuted(true). The mute choice is saved on this device.
(function () {
  const KEY = "gw-muted";
  let muted = false;
  try { muted = localStorage.getItem(KEY) === "1"; } catch {}

  let ctx = null;
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  // Browsers only allow audio after a user gesture, so unlock on the first tap/key.
  for (const ev of ["pointerdown", "keydown"]) {
    window.addEventListener(ev, () => audio(), { once: true, capture: true });
  }

  // One oscillator note with a quick attack and smooth fade.
  function tone(freq, start, dur, { type = "sine", gain = 0.16, slideTo } = {}) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime + start;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  // A short filtered noise burst: sounds like a card flipping.
  function swish(dur = 0.08, gain = 0.2, freq = 2400) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const amp = c.createGain();
    src.buffer = buf;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(freq, t);
    filter.frequency.exponentialRampToValueAtTime(freq / 3, t + dur);
    amp.gain.setValueAtTime(gain, t);
    src.connect(filter).connect(amp).connect(c.destination);
    src.start(t);
  }

  const SOUNDS = {
    flip:  () => swish(0.08, 0.22, 2600),
    tap:   () => tone(1100, 0, 0.05, { type: "triangle", gain: 0.07 }),
    yes:   () => { tone(660, 0, 0.14, { type: "triangle" }); tone(990, 0.1, 0.24, { type: "triangle" }); },
    no:    () => { tone(440, 0, 0.16, { type: "triangle" }); tone(294, 0.12, 0.28, { type: "triangle" }); },
    turn:  () => { tone(880, 0, 0.12, { gain: 0.09 }); tone(1320, 0.08, 0.2, { gain: 0.07 }); },
    win:   () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.32, { type: "triangle", gain: 0.15 })),
    lose:  () => [392, 330, 262].forEach((f, i) => tone(f, i * 0.17, 0.38, { type: "sawtooth", gain: 0.05 })),
    pop:   () => tone(500, 0, 0.1, { slideTo: 1100, gain: 0.12 }),
  };

  window.sfx = {
    context: () => audio(), // shared with music.js
    play(name) {
      if (muted) return;
      try { SOUNDS[name]?.(); } catch { /* audio unavailable */ }
    },
    get muted() { return muted; },
    setMuted(value) {
      muted = Boolean(value);
      try { localStorage.setItem(KEY, muted ? "1" : "0"); } catch {}
    },
  };
})();
