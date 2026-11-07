// 声区メーター：端末内（localStorage）への保存。呼び名はニックネームだけを扱う
const KEY_PROFILES = 'voiceMeter.profiles';
const KEY_CURRENT = 'voiceMeter.currentProfile';
const KEY_SESSIONS = 'voiceMeter.sessions.'; // + プロフィールID
const MAX_SESSIONS = 12;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn('読み込みに失敗', key, e);
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('保存に失敗', key, e);
    return false;
  }
}

export const loadProfiles = () => read(KEY_PROFILES, []);
export const saveProfiles = (list) => write(KEY_PROFILES, list);
export const loadCurrentId = () => read(KEY_CURRENT, null);
export const saveCurrentId = (id) => write(KEY_CURRENT, id);
export const loadSessions = (profileId) => read(KEY_SESSIONS + profileId, []);

export function saveSession(profileId, session) {
  const list = [...loadSessions(profileId), session].slice(-MAX_SESSIONS);
  return write(KEY_SESSIONS + profileId, list);
}

export function deleteProfileData(profileId) {
  try { localStorage.removeItem(KEY_SESSIONS + profileId); } catch (e) { console.warn(e); }
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
