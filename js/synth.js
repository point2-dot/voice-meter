// 声区メーター：合成音（テストとデモ用）
// 倍音の強さが 1/k^slope で下がる音を作る。slope が大きいほど倍音が弱い（裏声に近い）。

// 再現できる乱数（テストの結果が毎回同じになるように）
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

export function synthVoice({ f0, slope, sr = 48000, length = 4096, phase = 0, noise = 0, seed = 1 }) {
  const out = new Float32Array(length);
  const random = makeRandom(seed);
  const maxHarmonic = Math.floor((sr / 2 - 100) / f0);
  const amps = [];
  let total = 0;
  for (let k = 1; k <= maxHarmonic; k++) {
    const a = 1 / Math.pow(k, slope);
    amps.push(a);
    total += a * a;
  }
  const gain = 0.1 / Math.sqrt(total / 2); // 音量をそろえる（RMS ≒ 0.1）
  for (let i = 0; i < length; i++) {
    const t = (i + phase) / sr;
    let v = 0;
    for (let k = 1; k <= maxHarmonic; k++) v += amps[k - 1] * Math.sin(2 * Math.PI * k * f0 * t + k * 0.7);
    out[i] = v * gain + noise * random() * 2;
  }
  return out;
}
