// 声区メーター：値のなめらか化と、ひっくり返りの検出
import { computeScore, computeBreathiness } from './score.js';

// ひっくり返りの判定。実際の声で調整した（eval/flips_tune.mjs）
const FLIP_DEFAULTS = {
  threshold: 50, // 前後の値の差がこれ以上
  maxSpread: 35, // 前後それぞれの区間の値の幅がこれ以下（落ち着いている）
  maxPitchMove: 5, // 前後の高さの差がこれ以下（半音）
  upwardOnly: true, // 地声→裏声の向きだけを数える（誤検出が減るため）
  beforeFrom: 600, beforeTo: 300, // 「前」の区間（いまから何ms前）
  afterLen: 250, // 「後」の区間の長さ（ms）
  maxGap: 120, // この長さまでの途切れは同じ声の続きとみなす
  cooldown: 900, // 一度検出したら、しばらく検出しない
};

const medianOf = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const spreadOf = (a) => Math.max(...a) - Math.min(...a);

export class Tracker {
  constructor(options = {}) {
    this.flip = { ...FLIP_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.recent = [];
    this.smooth = null;
    this.breath = null;
    this.lastVoicedAt = -1e9;
    this.run = []; // 声が続いているあいだの値
    this.lastFlipAt = -1e9;
  }

  update(result, now, points) {
    const raw = result.voiced ? computeScore(result.feat, result.midi, points) : null;
    if (raw == null) {
      this.step(null, null, now);
      return { voiced: false, reason: result.reason, rms: result.rms };
    }
    const breathRaw = computeBreathiness(result.feat, points);
    if (breathRaw != null) this.breath = this.breath == null ? breathRaw : this.breath + 0.15 * (breathRaw - this.breath);
    const flip = this.step(raw, result.midi, now);
    return { voiced: true, score: this.smooth, midi: result.midi, breath: this.breath, flip };
  }

  // 1フレーム分の値を受け取り、ひっくり返りを見つけたら true を返す
  step(raw, midi, now) {
    if (raw == null) {
      if (now - this.lastVoicedAt > this.flip.maxGap) this.run = [];
      if (now - this.lastVoicedAt > 400) { this.smooth = null; this.recent = []; }
      return false;
    }
    this.lastVoicedAt = now;
    this.recent.push(raw);
    if (this.recent.length > 5) this.recent.shift();
    const med = medianOf(this.recent);
    this.smooth = this.smooth == null ? med : this.smooth + 0.25 * (med - this.smooth);

    this.run.push({ t: now, value: med, midi });
    while (this.run.length && now - this.run[0].t > this.flip.beforeFrom + 40) this.run.shift();
    return this.detectFlip(now);
  }

  // 落ち着いた状態から別の落ち着いた状態へ、高さを保ったまま移ったか
  detectFlip(now) {
    const o = this.flip;
    if (now - this.lastFlipAt < o.cooldown || !this.run.length || now - this.run[0].t < o.beforeFrom - 40) return false;
    const before = this.run.filter((p) => now - p.t <= o.beforeFrom && now - p.t >= o.beforeTo);
    const after = this.run.filter((p) => now - p.t <= o.afterLen);
    if (before.length < 4 || after.length < 3) return false;
    const a = before.map((p) => p.value);
    const b = after.map((p) => p.value);
    const jump = medianOf(b) - medianOf(a);
    if ((o.upwardOnly ? jump : Math.abs(jump)) < o.threshold) return false;
    if (spreadOf(a) > o.maxSpread || spreadOf(b) > o.maxSpread) return false;
    if (Math.abs(medianOf(after.map((p) => p.midi)) - medianOf(before.map((p) => p.midi))) > o.maxPitchMove) return false;
    this.lastFlipAt = now;
    return true;
  }
}
