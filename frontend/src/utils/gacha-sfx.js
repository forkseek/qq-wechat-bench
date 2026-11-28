// 扭蛋机音效：全部用 Web Audio 现场合成，不带音频文件。
// 旋钮咔哒、塑料球碰撞、胶囊落地、开盖啵一声、出签小叮咚。

const SOUND_KEY = 'xunke.gachaSound';
let ctx = null;
let master = null;

export function soundEnabled() {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}

export function setSoundEnabled(on) {
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* 无痕窗口等 */ }
}

function audio() {
  if (!soundEnabled()) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ freq, freqEnd = freq, dur = 0.12, type = 'sine', gain = 0.2, delay = 0 }) {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

let noiseBuf = null;
function noise({ dur = 0.05, gain = 0.2, delay = 0, freq = 2000, q = 1, type = 'bandpass' }) {
  const a = audio();
  if (!a) return;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t0 = a.currentTime + delay;
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0, Math.random() * 0.4);
  src.stop(t0 + dur + 0.02);
}

export const sfx = {
  // 拧旋钮：一串越来越慢的棘轮咔哒
  crank() {
    let t = 0;
    for (let i = 0; i < 7; i++) {
      noise({ dur: 0.03, gain: 0.5, delay: t, freq: 2600 + Math.random() * 600, q: 6 });
      tone({ freq: 1800, freqEnd: 1200, dur: 0.025, type: 'square', gain: 0.05, delay: t });
      t += 0.07 + i * 0.012;
    }
  },
  // 球在罩子里乱撞：一阵高低不一的塑料“哒哒”
  rattle() {
    for (let i = 0; i < 14; i++) {
      const d = 0.05 + Math.random() * 0.62;
      tone({ freq: 900 + Math.random() * 900, freqEnd: 600, dur: 0.045, type: 'triangle', gain: 0.12 + Math.random() * 0.1, delay: d });
      noise({ dur: 0.02, gain: 0.12, delay: d, freq: 3500, q: 3 });
    }
  },
  // 3D 版：旋钮每转一格的棘轮“咔”
  tick() {
    noise({ dur: 0.035, gain: 0.55, freq: 2400 + Math.random() * 500, q: 7 });
    tone({ freq: 1500, freqEnd: 900, dur: 0.03, type: 'square', gain: 0.06 });
    noise({ dur: 0.05, gain: 0.18, freq: 420, q: 1.5, delay: 0.012 });
  },
  // 3D 版：球真实撞到一下就响一下，力度决定音量和音高
  clack(strength = 0.5) {
    const s = Math.max(0.15, Math.min(1, strength));
    tone({ freq: 1000 + Math.random() * 800, freqEnd: 650, dur: 0.04 + s * 0.02, type: 'triangle', gain: 0.05 + s * 0.17 });
    noise({ dur: 0.02, gain: 0.05 + s * 0.12, freq: 3200, q: 3 });
  },
  // 3D 版：胶囊落到托盘上，力度随弹跳减小
  land(strength = 1) {
    const s = Math.max(0.2, Math.min(1, strength));
    tone({ freq: 210, freqEnd: 80, dur: 0.18, type: 'sine', gain: 0.5 * s });
    noise({ dur: 0.05, gain: 0.25 * s, freq: 900, q: 1.2 });
  },
  // 胶囊掉进出口：咚一下，再小弹一下
  drop() {
    tone({ freq: 190, freqEnd: 70, dur: 0.22, type: 'sine', gain: 0.55 });
    noise({ dur: 0.06, gain: 0.3, freq: 700, q: 1.2 });
    tone({ freq: 150, freqEnd: 80, dur: 0.12, type: 'sine', gain: 0.25, delay: 0.2 });
    noise({ dur: 0.03, gain: 0.12, freq: 900, q: 1.5, delay: 0.2 });
  },
  // 开盖：啵
  pop() {
    tone({ freq: 320, freqEnd: 980, dur: 0.09, type: 'sine', gain: 0.45 });
    noise({ dur: 0.05, gain: 0.25, freq: 1800, q: 0.8, type: 'highpass' });
  },
  // 出签：叮—咚—叮 小三和弦
  chime() {
    const notes = [784, 988, 1319];
    notes.forEach((f, i) => {
      tone({ freq: f, dur: 0.42, type: 'triangle', gain: 0.18, delay: 0.09 * i });
      tone({ freq: f * 2, dur: 0.22, type: 'sine', gain: 0.04, delay: 0.09 * i });
    });
  },
  // 入场时玻璃上闪过高光：很轻的一串往上走的小亮音
  sparkle() {
    [1568, 2093, 2637].forEach((f, i) => {
      tone({ freq: f, dur: 0.16, type: 'sine', gain: 0.05, delay: 0.045 * i });
    });
  },
  // 静音开关打开时的提示音
  blip() {
    tone({ freq: 660, freqEnd: 880, dur: 0.08, type: 'triangle', gain: 0.15 });
  }
};
