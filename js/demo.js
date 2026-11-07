// 声区メーター：デモ用（マイクなしで画面を確かめる。?demo=1 のときだけ読み込まれる）
import { synthVoice } from './synth.js';
import { analyzeFrame } from './dsp.js';
import { summarizeFrames } from './score.js';

export const DEMO_SR = 48000;
const DEMO_PITCHES = { low: 165, mid: 262, high: 392 };

// 時刻から合成音を作る。音の高さがゆっくり上がり、倍音の弱さ（裏声っぽさ）も波のように変わる
export function demoBuffer(tSec) {
  const wave = 0.5 - 0.5 * Math.cos(tSec / 5);
  const f0 = 170 * Math.pow(2, 0.9 * (0.5 - 0.5 * Math.cos(tSec / 7)));
  return synthVoice({ f0, slope: 1.0 + 2.4 * wave, sr: DEMO_SR, phase: Math.round(tSec * DEMO_SR) });
}

function recordSynth(f0, slope) {
  const frames = [];
  for (let i = 0; i < 12; i++) {
    const r = analyzeFrame(synthVoice({ f0, slope, sr: DEMO_SR, phase: i * 700, noise: 0.0005, seed: i + 1 }), DEMO_SR);
    if (r.voiced) frames.push(r);
  }
  return summarizeFrames(frames);
}

export function buildDemoProfile() {
  const slots = {};
  for (const [key, f0] of Object.entries(DEMO_PITCHES)) {
    slots[key] = { chest: recordSynth(f0, 0.8), falsetto: recordSynth(f0, 3.4) };
  }
  return { id: 'demo', name: 'デモ', slots };
}

// 前回・前々回の練習の記録（見た目の確認用）
export function buildDemoSessions() {
  const make = (offsetDays, bias) => {
    const pts = [];
    const flips = [];
    for (let t = 0; t < 24000; t += 80) {
      const s = t / 1000;
      const midi = 53 + 11 * (0.5 - 0.5 * Math.cos(s / 7.5));
      let score = 38 + bias + 22 * Math.sin(s / 3.2) * (0.5 + s / 48);
      if (s > 15.2 && s < 15.3) { score += 40; flips.push(pts.length); }
      pts.push([t, Number(midi.toFixed(2)), Math.max(0, Math.min(100, Math.round(score)))]);
    }
    return { t0: Date.now() - offsetDays * 86400000, dur: 24000, pts, flips, calibrated: true };
  };
  return [make(7, 10), make(2, 0)];
}
