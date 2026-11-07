// 声区メーター：信号処理（FFT・基本周波数推定・特徴量の計算）
// ブラウザでも Node（テスト）でも動くよう、DOM には触れない。

export const FRAME_SIZE = 4096; // 解析する波形の長さ（サンプル数）
export const NFFT = 8192; // ゼロ埋めして周波数の細かさを2倍にする
const MIN_RMS = 0.003; // これより小さい音は「無音」とみなす
const MIN_CONFIDENCE = 0.8; // 音程の確からしさがこれ未満なら「判定なし」
const MIN_F0 = 70;
const MAX_F0 = 1100;

// ---------- FFT ----------
const planCache = new Map();

function getPlan(n) {
  let plan = planCache.get(n);
  if (plan) return plan;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  plan = { cos, sin, rev };
  planCache.set(n, plan);
  return plan;
}

// 基数2の FFT（その場で書き換える）。長さは2のべき乗
export function fft(re, im) {
  const n = re.length;
  const { cos, sin, rev } = getPlan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// ---------- 基本周波数（YIN 法） ----------
export function detectPitch(buf, sr, minF = MIN_F0, maxF = MAX_F0, threshold = 0.15) {
  const win = 2048;
  const tauMin = Math.max(2, Math.floor(sr / maxF));
  const tauMax = Math.min(Math.floor(sr / minF), buf.length - win - 1);
  if (tauMax <= tauMin + 2) return null;

  // 差関数 → 累積平均正規化差関数
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const d = buf[j] - buf[j + tau];
      sum += d * d;
    }
    running += sum;
    cmnd[tau] = running > 0 ? (sum * tau) / running : 1;
  }

  // しきい値を下回る最初の谷を採用。なければ全体の最小
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let min = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < min) { min = cmnd[tau]; best = tau; }
    }
  }
  if (best < 0) return null;

  // 放物線補間で谷の位置を細かく求める
  let refined = best;
  if (best > 1 && best < tauMax) {
    const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) refined = best + (a - c) / (2 * denom);
  }
  return { f0: sr / refined, confidence: Math.max(0, 1 - cmnd[best]) };
}

export function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

const NOTE_NAMES = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];

// 音名（ドレミ）。C4（真ん中のド）= ド4
export function midiToNoteName(midi) {
  const n = Math.round(midi);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

// ---------- 特徴量 ----------
const hannCache = new Map();
function getHann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

export function peakPowerDb(power, df, freq, widthRatio) {
  const center = Math.round(freq / df);
  const w = Math.max(2, Math.round((freq * widthRatio) / df));
  let max = 0;
  for (let k = Math.max(1, center - w); k <= Math.min(power.length - 1, center + w); k++) {
    if (power[k] > max) max = power[k];
  }
  return 10 * Math.log10(max + 1e-20);
}

export function bandEnergy(power, df, lo, hi) {
  let sum = 0;
  const kLo = Math.max(1, Math.floor(lo / df));
  const kHi = Math.min(power.length - 1, Math.floor(hi / df));
  for (let k = kLo; k < kHi; k++) sum += power[k];
  return sum;
}

// ケプストラムのピークの目立ち具合（CPP）。大きいほど声がはっきり、小さいほど息っぽい
function cepstralPeakProminence(power, df, f0) {
  const K = 1024;
  const size = 2 * K;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let mean = 0;
  for (let k = 0; k < K; k++) {
    const v = 10 * Math.log10(power[k] + 1e-12);
    re[k] = v;
    re[size - 1 - k] = v;
    mean += v;
  }
  mean /= K;
  for (let k = 0; k < size; k++) re[k] -= mean;
  fft(re, im);
  const mag = new Float64Array(K);
  for (let n = 0; n < K; n++) mag[n] = Math.hypot(re[n], im[n]) / K;

  const nPerHz = size * df; // ケフレンシー番号 = nPerHz / 周波数
  const n0 = nPerHz / f0;
  const peakLo = Math.max(3, Math.floor(n0 * 0.85));
  const peakHi = Math.min(K - 2, Math.ceil(n0 * 1.18));
  let peakIdx = peakLo;
  for (let n = peakLo; n <= peakHi; n++) if (mag[n] > mag[peakIdx]) peakIdx = n;

  // ピーク付近の背景を直線で近似して差を取る
  const fitLo = Math.max(2, Math.min(Math.floor(nPerHz * 0.001), Math.floor(n0 * 0.6)));
  const fitHi = Math.min(K - 1, Math.max(Math.ceil(nPerHz / 60), Math.ceil(n0 * 1.3)));
  let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
  for (let n = fitLo; n <= fitHi; n++) {
    sx += n; sy += mag[n]; sxx += n * n; sxy += n * mag[n]; cnt++;
  }
  const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx || 1);
  const intercept = (sy - slope * sx) / cnt;
  return mag[peakIdx] - (intercept + slope * peakIdx);
}

// 窓をかけてパワースペクトルを求める
export function powerSpectrum(buf) {
  const win = getHann(FRAME_SIZE);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const offset = Math.max(0, buf.length - FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) re[i] = (buf[offset + i] || 0) * win[i];
  fft(re, im);
  const half = NFFT / 2;
  const power = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

// 1フレームを解析する。声として判定できないときは voiced:false
export function analyzeFrame(buf, sr) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (!(rms >= MIN_RMS)) return { voiced: false, reason: 'quiet', rms };

  const pitch = detectPitch(buf, sr);
  if (!pitch || pitch.confidence < MIN_CONFIDENCE) {
    return { voiced: false, reason: 'noPitch', rms };
  }
  const { f0 } = pitch;

  const power = powerSpectrum(buf);
  const df = sr / NFFT;

  if (2.5 * f0 > sr / 2) return { voiced: false, reason: 'noPitch', rms };
  const h1 = peakPowerDb(power, df, f0, 0.05);
  const h2 = peakPowerDb(power, df, 2 * f0, 0.05);
  const low = bandEnergy(power, df, 60, 1000);
  const high = bandEnergy(power, df, 1000, 5000);

  return {
    voiced: true,
    rms,
    f0,
    midi: freqToMidi(f0),
    confidence: pitch.confidence,
    feat: {
      h1h2: h1 - h2, // 大きいほど裏声・息もれ寄り
      tilt: 10 * Math.log10((low + 1e-20) / (high + 1e-20)), // 大きいほど高音域が弱い
      cpp: cepstralPeakProminence(power, df, f0), // 小さいほど息っぽい
      ...harmonicFeatures(power, df, f0),
    },
  };
}

// 倍音の様子を表す特徴量。実際の歌声で地声・ミックス・裏声の区別に効いたもの（eval/ 参照）
function harmonicFeatures(power, df, f0) {
  const count = Math.min(40, Math.floor(5000 / f0));
  const harmonics = [];
  for (let k = 1; k <= count; k++) harmonics.push(peakPowerDb(power, df, k * f0, 0.04));
  const top = Math.max(...harmonics);
  const upper = harmonics.slice(1).reduce((sum, h) => sum + 10 ** (h / 10), 0);

  // 1.5〜5kHz で、倍音の山と山のあいだの谷の差（小さいほど高音域が雑音に埋もれている）
  let gap = 0;
  let gapCount = 0;
  for (let k = Math.ceil(1500 / f0); (k + 1) * f0 <= 5000; k++) {
    gap += peakPowerDb(power, df, k * f0, 0.04) - 10 * Math.log10(power[Math.round(((k + 0.5) * f0) / df)] + 1e-20);
    gapCount++;
  }

  // 音の重心（オクターブ単位）。声が明るいほど大きい
  let weighted = 0;
  let total = 0;
  for (let k = Math.round(100 / df); k < Math.round(5000 / df); k++) {
    weighted += power[k] * Math.log2(k * df);
    total += power[k];
  }

  return {
    hrf: count > 1 ? 10 * Math.log10(upper / 10 ** (harmonics[0] / 10)) : null, // 倍音の豊かさ
    hnrHi: gapCount ? gap / gapCount : null, // 高音域の倍音の明瞭さ
    centroid: weighted / (total + 1e-20), // 音の重心
    rich: harmonics.filter((h) => h > top - 30).length, // 目立つ倍音の数
  };
}
