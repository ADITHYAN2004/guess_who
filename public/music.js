// Background music: three original looping tracks, composed and played live with the
// Web Audio API (no audio files, nothing copyrighted, works offline).
// Usage: music.setOn(true), music.setTrack("tabla"). Choices are saved on this device.
(function () {
  const KEY_ON = "gw-music";
  const KEY_TRACK = "gw-track";
  const VOLUME = 0.55; // music sits under the sound effects
  const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  let on = read(KEY_ON, "1") === "1"; // on by default; starts after the first tap (browser rule)
  let trackId = read(KEY_TRACK, "chai");

  let ctx = null, master = null, noiseBuf = null;
  let timer = null, step = 0, nextTime = 0, playing = false;
  let lastLead = null; // previous lead frequency, for the flute's slides
  let warned = false;

  const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);

  function setup() {
    ctx = window.sfx?.context?.();
    if (!ctx) return false;
    if (!master) {
      master = ctx.createGain();
      master.gain.value = 0.0001;
      const comp = ctx.createDynamicsCompressor(); // keeps the mix smooth
      master.connect(comp).connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return true;
  }

  // ---------- instruments ----------
  // Envelope helper: quick attack, exponential fade.
  function amp(t, peak, attack, dur) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(master);
    return g;
  }
  function tone(type, freq, t, dur, peak, { attack = 0.008, cutoff, detune = 0 } = {}) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    const out = amp(t, peak, attack, dur);
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = cutoff;
      o.connect(f).connect(out);
    } else o.connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }
  function noise(t, dur, peak, { type = "highpass", freq = 6000, q = 0.7 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f).connect(amp(t, peak, 0.002, dur));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }
  // Pitch-dropping drum (kick, tabla bass strokes).
  function thump(t, from, to, dur, peak) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.6);
    o.connect(amp(t, peak, 0.004, dur));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  const kick = t => thump(t, 130, 45, 0.28, 0.55);
  const snare = t => { noise(t, 0.16, 0.16, { freq: 1800 }); tone("triangle", 190, t, 0.08, 0.08); };
  const hat = (t, open) => noise(t, open ? 0.18 : 0.04, open ? 0.05 : 0.04, { freq: 7500 });
  const ep = (midi, t, dur, peak = 0.05) => { // soft electric piano
    tone("sine", hz(midi), t, dur, peak, { attack: 0.01 });
    tone("triangle", hz(midi + 12), t, dur * 0.5, peak * 0.25, { attack: 0.005 });
  };
  const bass = (midi, t, dur) => tone("triangle", hz(midi), t, dur, 0.22, { cutoff: 500, attack: 0.01 });
  const mallet = (midi, t, dur) => { tone("sine", hz(midi), t, dur, 0.07, { attack: 0.005 }); tone("sine", hz(midi + 24), t, 0.12, 0.012); };

  // Tabla strokes: bayan (low drum) + dayan (high drum).
  const tabla = {
    dha: t => { thump(t, 120, 70, 0.45, 0.32); tone("sine", 540, t, 0.22, 0.12); },
    dhi: t => { thump(t, 115, 75, 0.35, 0.26); tone("sine", 610, t, 0.18, 0.1); },
    ge:  t => thump(t, 100, 62, 0.5, 0.3),
    na:  t => { tone("sine", 660, t, 0.16, 0.13); noise(t, 0.02, 0.05, { freq: 3000 }); },
    ti:  t => { tone("sine", 880, t, 0.07, 0.07); noise(t, 0.015, 0.05, { freq: 4000 }); },
    ka:  t => noise(t, 0.05, 0.08, { type: "bandpass", freq: 900, q: 2 }),
  };
  // Bansuri-style flute: soft tone, gentle vibrato, breath, and slides between notes.
  function flute(midi, t, dur) {
    const f = hz(midi);
    const o = ctx.createOscillator();
    o.type = "sine";
    const from = lastLead && Math.abs(lastLead / f - 1) < 0.35 ? lastLead : f;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 5.2;
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.35, dur));
    lfo.connect(depth).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.05);
    g.gain.setValueAtTime(0.08, t + Math.max(0.06, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    g.connect(master);
    o.connect(g);
    o.start(t); lfo.start(t);
    o.stop(t + dur + 0.2); lfo.stop(t + dur + 0.2);
    noise(t, 0.12, 0.012, { type: "bandpass", freq: f * 2, q: 1.5 }); // breath
    lastLead = f;
  }
  // Tanpura-like drone: two soft, slowly fading saws.
  function drone(midis, t, dur) {
    for (const m of midis) {
      for (const det of [-6, 6]) tone("sawtooth", hz(m), t, dur, 0.018, { attack: 0.6, cutoff: 1100, detune: det });
    }
  }
  const square = (midi, t, dur, peak = 0.045) => tone("square", hz(midi), t, dur, peak, { attack: 0.004, cutoff: 3500 });

  // Melodies are lists of [stepInLoop, midi, lengthInSteps]; one step = a 16th note.
  const at = (list, s) => list.filter(n => n[0] === s);

  // ---------- track 1: Chai Break (lo-fi) ----------
  const CHAI_CHORDS = [[65, 69, 72, 76], [64, 67, 71, 74], [62, 65, 69, 72], [60, 64, 67, 71]]; // Fmaj7 Em7 Dm7 Cmaj7
  const CHAI_ROOTS = [41, 40, 38, 36];
  const CHAI_MELODY = [
    [2, 76, 2], [4, 79, 4], [10, 76, 2], [12, 74, 4],
    [18, 74, 2], [20, 76, 2], [22, 74, 2], [24, 71, 6],
    [34, 69, 2], [36, 72, 2], [38, 74, 4], [44, 72, 2], [46, 69, 2],
    [48, 67, 8], [60, 64, 4],
    [66, 76, 2], [68, 79, 2], [70, 81, 4], [76, 79, 4],
    [82, 76, 2], [84, 74, 2], [86, 76, 4], [92, 71, 4],
    [96, 72, 2], [98, 74, 2], [100, 72, 2], [102, 69, 6], [110, 67, 2],
    [112, 72, 12],
  ];

  // ---------- track 2: Tabla Groove (raga Yaman flavour, Sa = D) ----------
  const SA = 74; // flute register
  const Y = { "N.": -1, S: 0, R: 2, G: 4, M: 6, P: 7, D: 9, N: 11, "S'": 12 };
  const yaman = (s, sw, len) => [s, SA + Y[sw], len];
  const TABLA_MELODY = [
    yaman(0, "N.", 4), yaman(4, "R", 4), yaman(8, "G", 8),
    yaman(16, "R", 2), yaman(18, "G", 2), yaman(20, "R", 4), yaman(24, "S", 8),
    yaman(32, "G", 4), yaman(36, "M", 4), yaman(40, "P", 6), yaman(46, "M", 2),
    yaman(48, "G", 4), yaman(52, "R", 4), yaman(56, "S", 8),
    yaman(64, "P", 4), yaman(68, "D", 4), yaman(72, "N", 4), yaman(76, "S'", 4),
    yaman(80, "N", 2), yaman(82, "D", 2), yaman(84, "P", 4), yaman(88, "M", 4), yaman(92, "G", 4),
    yaman(96, "M", 4), yaman(100, "D", 4), yaman(104, "N", 2), yaman(106, "D", 2), yaman(108, "P", 4),
    yaman(112, "G", 2), yaman(114, "R", 2), yaman(116, "N.", 4), yaman(120, "R", 2), yaman(122, "G", 2), yaman(124, "S", 4),
  ];
  const KEHERWA = { 0: "dha", 2: "ge", 4: "na", 6: "ti", 8: "na", 10: "ka", 12: "dhi", 14: "na" };

  // ---------- track 3: Arcade Bounce (chiptune) ----------
  const ARC_ROOTS = [48, 45, 41, 43]; // C Am F G
  const ARC_A = [
    [0, 72, 2], [2, 76, 2], [4, 79, 2], [6, 84, 2], [8, 83, 2], [10, 79, 2], [12, 76, 4],
    [16, 76, 2], [18, 72, 2], [20, 69, 4], [24, 72, 2], [26, 76, 2], [28, 74, 4],
    [32, 77, 2], [34, 76, 2], [36, 74, 2], [38, 72, 2], [40, 74, 4], [44, 77, 4],
    [48, 79, 6], [54, 77, 2], [56, 76, 2], [58, 74, 2], [60, 71, 4],
  ];
  const ARC_MELODY = [...ARC_A, ...ARC_A.slice(0, 20).map(([s, m, l]) => [s + 64, m, l]),
    [112, 72, 2], [116, 79, 2], [120, 84, 8]];

  const TRACKS = {
    chai: {
      name: "Chai Break", desc: "Lo-fi chill", bpm: 78, loop: 128, swing: 0.22,
      play(s, t, spb) {
        const bar = Math.floor(s / 16) % 4, b = s % 16;
        if (b === 0) CHAI_CHORDS[bar].forEach(m => ep(m, t, spb * 7));
        if (b === 10) CHAI_CHORDS[bar].forEach(m => ep(m, t, spb * 5, 0.035));
        if (b === 0 || b === 8) bass(CHAI_ROOTS[bar], t, spb * 6);
        if (b === 14) bass(CHAI_ROOTS[bar] + 7, t, spb * 2);
        if (b === 0 || b === 7 || b === 10) kick(t);
        if (b === 4 || b === 12) snare(t);
        if (b % 2 === 0) hat(t, b === 14);
        for (const [, m, l] of at(CHAI_MELODY, s)) mallet(m, t, spb * l);
      },
    },
    tabla: {
      name: "Tabla Groove", desc: "Indian flute & tabla", bpm: 92, loop: 128,
      play(s, t, spb) {
        const b = s % 16;
        if (s % 32 === 0) { lastLead = null; drone([50, 57, 62], t, spb * 32); }
        if (KEHERWA[b] && !(Math.floor(s / 16) % 4 === 3 && b >= 12)) tabla[KEHERWA[b]](t);
        if (Math.floor(s / 16) % 4 === 3 && b >= 12) (b % 2 ? tabla.ti : tabla.na)(t); // little fill every 4 bars
        for (const [, m, l] of at(TABLA_MELODY, s)) flute(m, t, spb * l);
      },
    },
    arcade: {
      name: "Arcade Bounce", desc: "Retro game tune", bpm: 128, loop: 128,
      play(s, t, spb) {
        const bar = Math.floor(s / 16) % 4, b = s % 16;
        if (b % 2 === 0) tone("triangle", hz(ARC_ROOTS[bar] + (b % 4 ? 12 : 0)), t, spb * 1.8, 0.16);
        if (b === 0 || b === 8) kick(t);
        if (b === 4 || b === 12) noise(t, 0.1, 0.1, { freq: 2500 });
        if (b % 2 === 0) hat(t);
        for (const [, m, l] of at(ARC_MELODY, s)) square(m, t, spb * l * 0.9);
      },
    },
  };

  // ---------- scheduler: queue notes slightly ahead of time for steady timing ----------
  function tick() {
    const tr = TRACKS[trackId] || TRACKS.chai;
    const spb = 60 / tr.bpm / 4;
    while (nextTime < ctx.currentTime + 0.15) {
      const swing = tr.swing && step % 2 ? tr.swing * spb : 0;
      try { tr.play(step % tr.loop, nextTime + swing, spb); }
      catch (err) { if (!warned) { warned = true; console.warn("[music] skipped a note:", err); } } // keep playing
      nextTime += spb;
      step++;
    }
  }

  function start() {
    if (!on || playing || document.hidden || !setup()) return;
    playing = true;
    step = 0;
    lastLead = null;
    nextTime = ctx.currentTime + 0.08;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(VOLUME, ctx.currentTime + 1.2);
    timer = setInterval(tick, 40);
    tick();
  }

  function stop() {
    if (!playing) return;
    playing = false;
    clearInterval(timer);
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
  }

  // Browsers block audio until the first tap/key press; start then.
  for (const ev of ["pointerdown", "keydown"]) {
    window.addEventListener(ev, () => { if (on) start(); }, { capture: true });
  }
  // Pause when the app is in the background (saves battery), resume when it's back.
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : on && start()));

  window.music = {
    tracks: Object.entries(TRACKS).map(([id, t]) => ({ id, name: t.name, desc: t.desc })),
    get on() { return on; },
    get track() { return trackId; },
    get playing() { return playing; },
    setOn(value) {
      on = Boolean(value);
      write(KEY_ON, on ? "1" : "0");
      on ? start() : stop();
    },
    setTrack(id) {
      if (!TRACKS[id]) return;
      trackId = id;
      write(KEY_TRACK, id);
      if (playing) { stop(); setTimeout(start, 320); }
    },
  };
})();
