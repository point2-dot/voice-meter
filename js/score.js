// 声区メーター：特徴量を「地声=0 〜 裏声=100」の位置に変換する
// 重みと標準値は、実際の歌声（eval/ の検証）で決めた。声の音源そのものはアプリに含まない

// 特徴量ごとの重みと、「基準の差がこれ未満なら当てにしない」下限
const FEATURES = {
  cpp: { weight: 3, minSep: 0.3 },
  hrf: { weight: 2, minSep: 3 },
  hnrHi: { weight: 1.5, minSep: 2 },
  centroid: { weight: 1.5, minSep: 0.15 },
  rich: { weight: 0.5, minSep: 1 },
};
const FEATURE_KEYS = Object.keys(FEATURES);

// 実際の声では、ミックスは地声と裏声の中点より裏声側に出る。真ん中へ寄せるための曲線
const SCORE_CURVE = 1.3;

// 基準を録っていないときの標準値（高さごと。人によって違うので仮の値）
export const DEFAULT_POINTS = [
  { midi: 56, chest: { cpp: 9.1, hrf: 8.2, hnrHi: 25.9, centroid: 9.42, rich: null }, falsetto: { cpp: 4.7, hrf: -6.4, hnrHi: 16.1, centroid: 8.15, rich: null } },
  { midi: 64, chest: { cpp: 8.2, hrf: 8.9, hnrHi: 29.5, centroid: 9.68, rich: null }, falsetto: { cpp: 5.3, hrf: -1.4, hnrHi: 22.1, centroid: 8.92, rich: null } },
  { midi: 72, chest: { cpp: 8.4, hrf: 7.5, hnrHi: 34.2, centroid: 9.83, rich: null }, falsetto: { cpp: 5.4, hrf: -0.3, hnrHi: 27.2, centroid: 9.48, rich: null } },
];

const median = (arr) => {
  const s = arr.filter((v) => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// 録音した複数フレームから、基準1件（高さと特徴量の中央値）を作る
export function summarizeFrames(frames) {
  const midis = frames.map((f) => f.midi);
  const mean = midis.reduce((a, b) => a + b, 0) / midis.length;
  const std = Math.sqrt(midis.reduce((a, b) => a + (b - mean) ** 2, 0) / midis.length);
  return {
    midi: median(midis),
    pitchStd: std,
    feat: Object.fromEntries(FEATURE_KEYS.map((k) => [k, median(frames.map((f) => f.feat[k]))])),
  };
}

// プロフィールの基準（slots）から、地声と裏声の両方がそろった高さの点を高さ順に取り出す
export function calibrationPoints(slots) {
  if (!slots) return [];
  return Object.values(slots)
    .filter((s) => s && s.chest && s.falsetto)
    .map((s) => ({ midi: (s.chest.midi + s.falsetto.midi) / 2, chest: s.chest.feat, falsetto: s.falsetto.feat }))
    .sort((a, b) => a.midi - b.midi);
}

const lerpFeat = (x, y, t) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, x[k] == null || y[k] == null ? null : x[k] + (y[k] - x[k]) * t]));

// いまの高さに近い基準を、前後の点から線形に補間する
export function interpolateRef(points, midi) {
  if (points.length === 1 || midi <= points[0].midi) return points[0];
  const last = points[points.length - 1];
  if (midi >= last.midi) return last;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (midi <= b.midi) {
      const t = (midi - a.midi) / (b.midi - a.midi || 1);
      return { chest: lerpFeat(a.chest, b.chest, t), falsetto: lerpFeat(a.falsetto, b.falsetto, t) };
    }
  }
  return last;
}

// 0（地声寄り）〜100（裏声寄り）。計算できないときは null
export function computeScore(feat, midi, points) {
  const ref = interpolateRef(points.length ? points : DEFAULT_POINTS, midi);
  let weighted = 0;
  let weightSum = 0;
  for (const [key, spec] of Object.entries(FEATURES)) {
    const c = ref.chest[key];
    const f = ref.falsetto[key];
    if (c == null || f == null || feat[key] == null) continue;
    const sep = f - c;
    const reliability = Math.min(1, Math.abs(sep) / spec.minSep);
    if (reliability < 0.2) continue;
    const t = Math.max(-0.3, Math.min(1.3, (feat[key] - c) / sep));
    const w = spec.weight * reliability;
    weighted += w * t;
    weightSum += w;
  }
  if (weightSum <= 0) return null;
  const position = Math.max(0, Math.min(1, weighted / weightSum));
  return 100 * position ** SCORE_CURVE;
}

// 息っぽさ 0（はっきり）〜100（息っぽい）。基準の中で一番はっきりした声を 0 の目安にする
export function computeBreathiness(feat, points) {
  const source = points.length ? points : DEFAULT_POINTS;
  const best = Math.max(...source.flatMap((p) => [p.chest.cpp, p.falsetto.cpp]));
  if (!(best > 0)) return null;
  return Math.max(0, Math.min(100, ((1 - feat.cpp / best) / 0.6) * 100));
}
