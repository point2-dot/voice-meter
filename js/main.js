// 声区メーター：画面の動き（メーター・履歴・基準の録音）
import { analyzeFrame, midiToNoteName, FRAME_SIZE } from './dsp.js';
import { calibrationPoints, summarizeFrames } from './score.js';
import { Tracker } from './tracker.js';
import * as store from './store.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo'); // マイクなしで画面を確かめるモード
const MIX_RANGE = [40, 60]; // 「ミックスの目安」の帯
const SLOTS = [
  { key: 'low', label: '低め' },
  { key: 'mid', label: '中くらい' },
  { key: 'high', label: '高め' },
];
const KIND_LABEL = { chest: '地声', falsetto: '裏声' };
const $ = (id) => document.getElementById(id);

const MIC_MESSAGES = {
  denied: 'マイクの使用が許可されていません。iPhone の「設定」→「Safari」→「マイク」で許可するか、ページを開き直して「許可」を選んでください。',
  nodevice: 'マイクが見つかりませんでした。マイクがつながっているか確かめてください。',
  unsupported: 'このブラウザーではマイクが使えません。iPhone の Safari で、https:// から始まるページとして開いてください。',
  other: 'マイクを始められませんでした。ほかのアプリがマイクを使っていないか確かめて、もう一度お試しください。',
};

class MicError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function classifyMicError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'nodevice';
  return 'other';
}

const micMessage = (err) => MIC_MESSAGES[(err && err.code) || 'other'] || MIC_MESSAGES.other;

// ---------- マイク（メーターと基準の録音で共有。使う人が0になったら止める） ----------
class MicEngine {
  constructor() {
    this.refs = 0;
    this.ready = null;
    this.listeners = new Set();
    this.timer = null;
    this.onLost = null;
  }

  async acquire() {
    this.refs++;
    try {
      if (!this.ready) this.ready = this.open();
      await this.ready;
    } catch (err) {
      this.refs--;
      this.ready = null;
      throw err;
    }
  }

  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0 && this.ready) {
      this.close();
      this.ready = null;
    }
  }

  async open() {
    if (DEMO) {
      this.demo = await import('./demo.js');
      this.sr = this.demo.DEMO_SR;
      this.startTime = performance.now();
    } else {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AudioCtx) {
        throw new MicError('unsupported');
      }
      // iPhone ではボタンを押した直後に作らないと止まったままになることがある
      this.ctx = new AudioCtx();
      const resumed = this.ctx.resume().catch((e) => console.warn(e));
      try {
        // iPhone の自動処理をできるだけ切る（声の特徴が変わってしまうため）
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
      } catch (err) {
        this.ctx.close().catch(() => {});
        this.ctx = null;
        throw new MicError(classifyMicError(err));
      }
      await resumed;
      this.sr = this.ctx.sampleRate;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FRAME_SIZE;
      this.analyser.smoothingTimeConstant = 0;
      this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
      this.buf = new Float32Array(FRAME_SIZE);
      this.stream.getAudioTracks().forEach((t) => {
        t.onended = () => { if (this.onLost) this.onLost(); };
      });
    }
    this.timer = setInterval(() => this.tick(), 40);
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }

  tick() {
    try {
      let buf;
      if (DEMO) {
        buf = this.demo.demoBuffer((performance.now() - this.startTime) / 1000);
      } else {
        this.analyser.getFloatTimeDomainData(this.buf);
        buf = this.buf;
      }
      const result = analyzeFrame(buf, this.sr);
      const now = performance.now();
      this.listeners.forEach((fn) => fn(result, now));
    } catch (err) {
      console.error('解析に失敗', err);
    }
  }
}

const engine = new MicEngine();

// ---------- 状態 ----------
const state = {
  profiles: [],
  currentId: null,
  running: false,
  session: null,
  target: null,
  shown: 50,
  flipUntil: 0,
  silentFrames: 0,
};
const tracker = new Tracker();
let rafId = 0;
let recording = false;

const currentProfile = () => state.profiles.find((p) => p.id === state.currentId) || state.profiles[0];
const currentPoints = () => calibrationPoints(currentProfile().slots);

function setMessage(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------- 色 ----------
const COLOR_STOPS = [[196, 122, 90], [185, 167, 122], [94, 140, 140]]; // テラコッタ → 砂 → くすんだ青緑
function scoreColor(score) {
  const t = Math.max(0, Math.min(1, score / 100)) * 2;
  const i = Math.min(1, Math.floor(t));
  const f = t - i;
  const c = COLOR_STOPS[i].map((v, k) => Math.round(v + (COLOR_STOPS[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------- プロフィール ----------
function initProfiles() {
  state.profiles = store.loadProfiles();
  if (!state.profiles.length) {
    state.profiles = [{ id: store.newId(), name: 'わたし', slots: {} }];
    store.saveProfiles(state.profiles);
  }
  const saved = store.loadCurrentId();
  state.currentId = state.profiles.some((p) => p.id === saved) ? saved : state.profiles[0].id;
}

function renderProfileSelect() {
  const sel = $('profileSelect');
  sel.innerHTML = '';
  for (const p of state.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = state.currentId;
}

function renderCalibNote() {
  const p = currentProfile();
  const n = currentPoints().length;
  $('calibNote').textContent = n
    ? `基準：${p.name}（${n}か所）をもとに表示しています。`
    : '基準がまだないので、標準の目安で表示しています（精度は下がります）。「基準」で録ると正確になります。';
}

function refreshAll() {
  renderProfileSelect();
  renderCalibNote();
  renderSlots();
  renderHistory(true);
}

// ---------- メーター ----------
function arcPoint(radius, score) {
  const theta = Math.PI * (1 - score / 100);
  return [150 + radius * Math.cos(theta), 150 - radius * Math.sin(theta)];
}

function drawMixBand() {
  const [x0, y0] = arcPoint(120, MIX_RANGE[0]);
  const [x1, y1] = arcPoint(120, MIX_RANGE[1]);
  $('mixBand').setAttribute('d', `M ${x0.toFixed(1)} ${y0.toFixed(1)} A 120 120 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`);
}

function verdictText(score) {
  if (score < 25) return '地声寄り';
  if (score < MIX_RANGE[0]) return 'やや地声寄り';
  if (score <= MIX_RANGE[1]) return 'ミックスの目安';
  if (score <= 75) return 'やや裏声寄り';
  return '裏声寄り';
}

function renderLoop() {
  if (state.target != null) state.shown += (state.target - state.shown) * 0.15;
  $('needle').setAttribute('transform', `rotate(${((state.shown - 50) * 1.8).toFixed(2)} 150 150)`);
  rafId = requestAnimationFrame(renderLoop);
}

function showIdle(text) {
  state.target = null;
  $('needle').classList.add('idle');
  $('verdict').textContent = text;
  $('noteName').textContent = '--';
}

function onMeterFrame(result, now) {
  const r = tracker.update(result, now, currentPoints());
  if (!r.voiced) {
    state.silentFrames++;
    if (state.silentFrames > 8) {
      showIdle(r.reason === 'noPitch' ? '音の高さがとれません。はっきり「アー」で歌ってみましょう' : '判定なし（声が聞こえません）');
    }
    if (state.silentFrames === 100 && r.rms < 0.001) {
      setMessage($('statusMsg'), 'マイクの音がほとんど入っていません。マイクの許可と、口との距離（20〜30cm）を確かめてください。', true);
    }
    return;
  }
  state.silentFrames = 0;
  if ($('statusMsg').classList.contains('error')) setMessage($('statusMsg'), '');
  state.target = r.score;
  $('needle').classList.remove('idle');
  $('noteName').textContent = midiToNoteName(r.midi);
  if (r.flip) state.flipUntil = now + 1500;
  const flipText = now < state.flipUntil ? '　◎ 声が切り替わりました' : '';
  $('verdict').textContent = verdictText(r.score) + flipText;
  $('breathBar').style.width = r.breath == null ? '0%' : `${r.breath.toFixed(0)}%`;

  // 記録（約12回/秒）
  const s = state.session;
  if (s) {
    const t = Math.round(now - s.startedAt);
    if (t - s.lastT >= 80) {
      s.pts.push([t, Number(r.midi.toFixed(2)), Math.round(r.score)]);
      s.lastT = t;
    }
    if (r.flip && s.pts.length) s.flips.push(s.pts.length - 1);
  }
}

async function startMeter() {
  const btn = $('startBtn');
  btn.disabled = true;
  setMessage($('statusMsg'), '');
  try {
    await engine.acquire();
  } catch (err) {
    setMessage($('statusMsg'), micMessage(err), true);
    btn.disabled = false;
    return;
  }
  tracker.reset();
  state.silentFrames = 0;
  state.session = { startedAt: performance.now(), lastT: -1000, pts: [], flips: [] };
  state.running = true;
  engine.listeners.add(onMeterFrame);
  engine.onLost = () => { setMessage($('statusMsg'), 'マイクが止まりました。もう一度「はじめる」を押してください。', true); stopMeter(); };
  btn.textContent = 'とめる';
  btn.classList.add('running');
  btn.disabled = false;
  document.querySelector('.meter-card').classList.add('active');
  showIdle('「アー」で歌ってみましょう');
  cancelAnimationFrame(rafId);
  renderLoop();
}

function stopMeter() {
  if (!state.running) return;
  state.running = false;
  engine.listeners.delete(onMeterFrame);
  engine.release();
  cancelAnimationFrame(rafId);
  const s = state.session;
  state.session = null;
  const btn = $('startBtn');
  btn.textContent = 'はじめる';
  btn.classList.remove('running');
  document.querySelector('.meter-card').classList.remove('active');
  showIdle('「はじめる」を押して、「アー」で歌ってみましょう');
  $('breathBar').style.width = '0%';

  if (s && s.pts.length >= 30) {
    const dur = s.pts[s.pts.length - 1][0];
    const ok = store.saveSession(currentProfile().id, { t0: Date.now() - dur, dur, pts: s.pts, flips: s.flips, calibrated: currentPoints().length > 0 });
    if (!$('statusMsg').classList.contains('error')) {
      setMessage($('statusMsg'), ok ? '練習の記録を保存しました。「履歴」で見られます。' : '記録を保存できませんでした（端末の保存領域を確かめてください）。', !ok);
    }
    renderHistory(true);
  }
}

// ---------- 基準の録音 ----------
function renderSlots() {
  const list = $('slotList');
  list.innerHTML = '';
  const slots = currentProfile().slots || {};
  for (const slot of SLOTS) {
    const box = document.createElement('div');
    box.className = 'slot';
    const title = document.createElement('h3');
    title.textContent = `${slot.label}の音`;
    const row = document.createElement('div');
    row.className = 'slot-buttons';
    for (const kind of ['chest', 'falsetto']) {
      const rec = slots[slot.key] && slots[slot.key][kind];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn rec-btn ${kind}${rec ? ' done' : ''}`;
      b.dataset.slot = slot.key;
      b.dataset.kind = kind;
      b.textContent = rec ? `${KIND_LABEL[kind]} ${midiToNoteName(rec.midi)} ✓
録り直す` : `${KIND_LABEL[kind]}を録る`;
      b.addEventListener('click', () => recordReference(slot.key, kind, b));
      row.appendChild(b);
    }
    const prog = document.createElement('div');
    prog.className = 'rec-progress';
    prog.innerHTML = '<span></span>';
    box.append(title, row, prog);
    list.appendChild(box);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function recordReference(slotKey, kind, button) {
  if (recording) return;
  if (state.running) { setMessage($('calibMsg'), '先にメーターを「とめる」にしてください。', true); return; }
  const msg = $('calibMsg');
  const profile = currentProfile();
  const other = kind === 'chest' ? 'falsetto' : 'chest';
  const partner = profile.slots[slotKey] && profile.slots[slotKey][other];
  const bar = button.closest('.slot').querySelector('.rec-progress > span');

  recording = true;
  document.querySelectorAll('.rec-btn').forEach((b) => { b.disabled = true; });
  try {
    await engine.acquire();
  } catch (err) {
    setMessage(msg, micMessage(err), true);
    recording = false;
    document.querySelectorAll('.rec-btn').forEach((b) => { b.disabled = false; });
    return;
  }
  button.classList.add('recording');
  setMessage(msg, `${KIND_LABEL[kind]}の用意… 1秒後に始まります。明るい「アー」で、同じ高さを保ちましょう。`);
  await wait(1000);

  const frames = [];
  const startedAt = performance.now();
  const RECORD_MS = 3000;
  const onFrame = (result, now) => {
    bar.style.width = `${Math.min(100, ((now - startedAt) / RECORD_MS) * 100)}%`;
    if (!result.voiced) { setMessage(msg, `${KIND_LABEL[kind]}を録音中… 声が聞こえません`); return; }
    frames.push(result);
    let text = `${KIND_LABEL[kind]}を録音中… いま ${midiToNoteName(result.midi)}`;
    if (partner) {
      const diff = result.midi - partner.midi;
      if (Math.abs(diff) > 1.5) text += `（${KIND_LABEL[other]}は ${midiToNoteName(partner.midi)}。${diff > 0 ? '少し低く' : '少し高く'}）`;
      else text += `（${KIND_LABEL[other]}と同じ高さ）`;
    }
    setMessage(msg, text);
  };
  engine.listeners.add(onFrame);
  await wait(RECORD_MS);
  engine.listeners.delete(onFrame);
  engine.release();

  button.classList.remove('recording');
  bar.style.width = '0%';
  document.querySelectorAll('.rec-btn').forEach((b) => { b.disabled = false; });
  recording = false;

  if (frames.length < 25) {
    setMessage(msg, '声がうまくとれませんでした。少し大きめに、はっきり「アー」と伸ばして、もう一度お試しください。', true);
    return;
  }
  const summary = summarizeFrames(frames);
  const gap = partner ? Math.abs(summary.midi - partner.midi) : 0;
  if (gap > 3) {
    setMessage(msg, `${KIND_LABEL[other]}（${midiToNoteName(partner.midi)}）と高さが離れています（今回 ${midiToNoteName(summary.midi)}）。同じ高さで録り直してください。`, true);
    return;
  }
  profile.slots[slotKey] = { ...(profile.slots[slotKey] || {}), [kind]: summary };
  store.saveProfiles(state.profiles);
  let done = `${KIND_LABEL[kind]}を保存しました（${midiToNoteName(summary.midi)}）。`;
  if (gap > 1.5) done += ' 相手の高さと少しずれています。可能なら録り直すと正確です。';
  else if (summary.pitchStd > 1) done += ' 音の高さが少し揺れました。一定に伸ばすとより正確です。';
  setMessage(msg, done);
  renderSlots();
  renderCalibNote();
}

function addProfile() {
  const input = $('newName');
  const name = input.value.trim().slice(0, 12);
  if (!name) { setMessage($('calibMsg'), 'ニックネームを入れてください。', true); return; }
  const p = { id: store.newId(), name, slots: {} };
  state.profiles.push(p);
  state.currentId = p.id;
  store.saveProfiles(state.profiles);
  store.saveCurrentId(p.id);
  input.value = '';
  setMessage($('calibMsg'), `「${name}」を追加しました。地声と裏声を録りましょう。`);
  refreshAll();
}

function deleteProfile() {
  const p = currentProfile();
  if (!window.confirm(`「${p.name}」の基準と練習の記録を消します。よろしいですか？`)) return;
  store.deleteProfileData(p.id);
  state.profiles = state.profiles.filter((x) => x.id !== p.id);
  if (!state.profiles.length) state.profiles = [{ id: store.newId(), name: 'わたし', slots: {} }];
  state.currentId = state.profiles[0].id;
  store.saveProfiles(state.profiles);
  store.saveCurrentId(state.currentId);
  setMessage($('calibMsg'), '消しました。');
  refreshAll();
}

// ---------- 履歴グラフ ----------
function sessionStats(s) {
  const scores = s.pts.map((p) => p[2]);
  const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const inMix = scores.filter((v) => v >= MIX_RANGE[0] && v <= MIX_RANGE[1]).length / (scores.length || 1);
  return `平均 ${avg.toFixed(0)} ／ ミックスの帯 ${(inMix * 100).toFixed(0)}% ／ ひっくり返り ${s.flips.length}回 ／ ${(s.dur / 1000).toFixed(0)}秒`;
}

function sessionLabel(s) {
  const d = new Date(s.t0);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function drawTrace(canvas, session, yRange) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cssW = canvas.clientWidth || 320;
  const cssH = Math.round(cssW / 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, cssW, cssH);
  g.font = '12px "Hiragino Maru Gothic ProN", sans-serif';

  const L = 40, R = 10, T = 10, B = 20;
  const [lo, hi] = yRange;
  const x = (t, dur) => L + ((cssW - L - R) * t) / Math.max(dur, 1);
  const y = (m) => T + ((cssH - T - B) * (hi - m)) / (hi - lo);

  // 目盛り（ド・ミ・ソ）
  g.textBaseline = 'middle';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    const pc = ((m % 12) + 12) % 12;
    if (pc !== 0 && pc !== 4 && pc !== 7) continue;
    g.strokeStyle = pc === 0 ? 'rgba(62,51,41,0.22)' : 'rgba(62,51,41,0.09)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, y(m)); g.lineTo(cssW - R, y(m)); g.stroke();
    g.fillStyle = '#7A6B5C';
    g.textAlign = 'right';
    g.fillText(midiToNoteName(m), L - 4, y(m));
  }
  if (!session) {
    g.fillStyle = '#7A6B5C'; g.textAlign = 'center';
    g.fillText('記録なし', cssW / 2, cssH / 2);
    return;
  }

  const pts = session.pts;
  g.lineWidth = 4;
  g.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] - pts[i - 1][0] > 300) continue; // 声が途切れたところは線をつながない
    g.strokeStyle = scoreColor(pts[i][2]);
    g.beginPath();
    g.moveTo(x(pts[i - 1][0], session.dur), y(pts[i - 1][1]));
    g.lineTo(x(pts[i][0], session.dur), y(pts[i][1]));
    g.stroke();
  }
  // ひっくり返りの印
  g.strokeStyle = '#3E3329';
  g.lineWidth = 2;
  for (const idx of session.flips) {
    const p = pts[idx];
    if (!p) continue;
    g.beginPath();
    g.arc(x(p[0], session.dur), y(p[1]), 7, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#7A6B5C'; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
  g.fillText(`${(session.dur / 1000).toFixed(0)}秒`, cssW - R, cssH - 5);
}

function renderHistory(showLatest = false) {
  const sessions = store.loadSessions(currentProfile().id);
  const empty = sessions.length === 0;
  $('historyEmpty').hidden = !empty;
  $('historyBody').hidden = empty;
  const selA = $('sessionA'), selB = $('sessionB');
  const keepA = selA.value, keepB = selB.value;
  selA.innerHTML = '';
  selB.innerHTML = '<option value="-1">なし</option>';
  sessions.forEach((s, i) => {
    const text = sessionLabel(s) + (s.calibrated ? '' : '（標準）');
    selA.add(new Option(text, String(i)));
    selB.add(new Option(text, String(i)));
  });
  if (empty) return;
  const last = sessions.length - 1;
  selA.value = keepA !== '' && Number(keepA) <= last && !showLatest ? keepA : String(last);
  selB.value = keepB !== '' && Number(keepB) <= last && !showLatest ? keepB : String(Math.max(-1, last - 1));
  drawHistory();
}

function drawHistory() {
  const sessions = store.loadSessions(currentProfile().id);
  const a = sessions[Number($('sessionA').value)] || null;
  const b = sessions[Number($('sessionB').value)] || null;
  const all = [a, b].filter(Boolean).flatMap((s) => s.pts.map((p) => p[1]));
  const lo = Math.floor(Math.min(...all, 100) - 1.5);
  const hi = Math.ceil(Math.max(...all, 0) + 1.5);
  const range = all.length ? [lo, Math.max(hi, lo + 7)] : [48, 72];
  $('captionA').textContent = a ? `見る：${sessionLabel(a)}` : '';
  $('captionB').textContent = b ? `比べる：${sessionLabel(b)}` : '';
  $('traceB').parentElement.hidden = !b;
  $('statsA').textContent = a ? sessionStats(a) : '';
  $('statsB').textContent = b ? sessionStats(b) : '';
  drawTrace($('traceA'), a, range);
  if (b) drawTrace($('traceB'), b, range);
}

// ---------- 画面の切り替え ----------
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'history') renderHistory();
  window.scrollTo(0, 0);
}

// ---------- デモ ----------
async function setupDemo() {
  const demo = await import('./demo.js');
  const profile = demo.buildDemoProfile();
  state.profiles = state.profiles.filter((p) => p.id !== 'demo');
  state.profiles.push(profile);
  state.currentId = 'demo';
  if (!store.loadSessions('demo').length) demo.buildDemoSessions().forEach((s) => store.saveSession('demo', s));
}

// ---------- 起動 ----------
async function init() {
  $('version').textContent = 'v0.2.0';
  initProfiles();
  if (DEMO) await setupDemo();
  drawMixBand();
  refreshAll();

  $('startBtn').addEventListener('click', () => (state.running ? stopMeter() : startMeter()));
  $('profileSelect').addEventListener('change', (e) => {
    if (state.running) stopMeter();
    state.currentId = e.target.value;
    store.saveCurrentId(state.currentId);
    refreshAll();
  });
  $('addProfileBtn').addEventListener('click', addProfile);
  $('deleteProfileBtn').addEventListener('click', deleteProfile);
  $('sessionA').addEventListener('change', drawHistory);
  $('sessionB').addEventListener('change', drawHistory);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  window.addEventListener('resize', () => { if (!$('view-history').hidden) drawHistory(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.running) stopMeter(); });

  const view = params.get('view');
  if (view) showView(view);
  if (DEMO && params.has('auto')) startMeter();

  if ('serviceWorker' in navigator && !DEMO && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker を登録できません', e));
  }
}

init().catch((err) => {
  console.error(err);
  setMessage($('statusMsg'), '起動に失敗しました。ページを開き直してください。', true);
});
