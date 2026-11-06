// lib/lobby.js
// 광장(대기실): 로그인한 사람끼리 넓은 지형 위를 상자 캐릭터로 돌아다니며 짧게 채팅합니다.
// - WebSocket 주소: wss://<서버>/lobby?token=<로그인 토큰>
// - 방은 1~ROOM_COUNT번. 들어오면 1번방부터 자리가 있는 방에 자동으로 들어갑니다.
//   모든 방이 차 있으면 연결은 유지한 채 방 목록만 받고, 자리가 나면 목록에서 골라 들어갑니다.
//   방마다 사람·채팅·황금 상자가 따로입니다.
// - 상태는 서버 메모리에만 둡니다. (DB에 저장하지 않음, 서버가 재시작되면 비워짐 · Render 서버 한 대 기준)
// - 위치는 0~1 비율로 주고받습니다. 지형 크기(WORLD_W × WORLD_H)는 화면(public/app.js)과 같아야 합니다.
// - 걷는 속도도 화면과 같아서, 서버가 "지금 어디쯤 걷고 있는지"를 계산할 수 있습니다. (황금 상자 거리 판정)
//
// [황금 상자] 접속자가 있으면 3~6분마다 지형 어딘가에 황금 상자가 나타나 70초 동안 돌아다닙니다.
//   가까이 가서 톡톡 두드리면(여럿이 같이 두드려도 됨) 열리고, 두드린 사람 모두 보상을 받습니다.
//   보상: 지금 모드에서 분당 수입 × 15분 골드(최소 3,000G) · 수집모드는 신화 조각 +5
//   거리와 두드린 횟수는 서버가 판정합니다.
//
// 받는 메시지(화면 → 서버)
//   { t: 'move', x, y }   이동할 자리      { t: 'chat', text }   채팅      { t: 'gtap' }   황금 상자 두드리기
//   { t: 'room', no }     그 방으로 옮기기 (가득 차 있으면 notice)
//   { t: 'report', cid }  채팅 신고 (서버가 가진 채팅 기록에서 찾아 저장)   { t: 'report', id }  같은 방 사용자 신고
// 보내는 메시지(서버 → 화면)
//   { t: 'rooms', rooms: [{ no, count, max }], current }   방 목록 (인원이 바뀌면 다시 보냄)
//   { t: 'allfull' }                             모든 방이 가득 참 (목록 화면에서 대기)
//   { t: 'init', room, me, players, chats, golden }   방에 들어간 직후 그 방의 전체 상태
//   { t: 'join', p } / { t: 'leave', id } / { t: 'update', p } / { t: 'move', id, x, y, dur }
//   { t: 'chat', c } / { t: 'notice', text }
//   { t: 'gspawn', g } / { t: 'gmove', x, y, dur } / { t: 'ghit', by, hp } / { t: 'gfar' }
//   { t: 'gopen', by: [id...] } / { t: 'ggone' } / { t: 'greward', gold, shards }
//
// [거대 황금 상자 레이드] 8~12분마다 분수 광장에 나타나 90초 동안 버팁니다. 방 사람들이 함께 두드려 체력을 깎고,
//   체력이 60%·25% 아래로 내려가면 섬 다른 곳으로 도망갑니다. 두드릴 때 12% 확률로 치명타(피해 2배).
//   성공하면 RAID_MIN_TAPS번 이상 두드린 사람 모두 보상 (참가자 1명 늘 때마다 +10%, 최대 2배) · 피해 1등(MVP)은 조각 추가.
//   받는 메시지 { t: 'rtap' } / 보내는 메시지 rspawn · rhit · rmove · rend · rreward
// [초월 사냥 혜택] 초월 횟수만큼 이동 속도·두드리는 사거리·한 번에 주는 피해가 늘어납니다. (huntPerks)

const { WebSocketServer } = require('ws');
const db = require('../db');
const { verifyTokenString } = require('./token');
const { withUserTransaction, describeError } = require('./http');
const store = require('../game/store');
const { MODES } = require('../game/config');

const ROOM_COUNT = 9;
const ROOM_CAPACITY = Number(process.env.LOBBY_ROOM_CAPACITY) || 20; // 환경변수는 로컬 시험용
const MAX_SOCKETS = ROOM_COUNT * ROOM_CAPACITY + 60; // 방이 다 찼을 때 목록에서 기다리는 연결까지
const ROOMS_BROADCAST_MS = 1000;                     // 방 인원 목록은 1초에 한 번까지만 알림
const CHAT_MAX_LENGTH = 60;
const CHAT_HISTORY = 30;
const CHAT_GAP_MS = 1500;        // 채팅은 1.5초에 한 번
const MOVE_GAP_MS = 120;         // 이동은 0.12초에 한 번
const PING_INTERVAL_MS = 30000;  // 끊긴 연결 정리 (응답 없는 연결은 다음 확인 때 닫음)
const MAX_MESSAGE_BYTES = 512;

// 신고: 하루 동안 서로 다른 MUTE_REPORTERS명 이상에게 신고받으면 광장 채팅을 막습니다.
const MUTE_REPORTERS = 3;
const MUTE_WINDOW = '24 hours';
const MUTE_CACHE_MS = 60 * 1000;     // 채팅마다 DB를 보지 않도록 1분 동안 결과를 기억
const REPORT_GAP_MS = 3000;

// 지형 크기와 걷는 속도 (public/app.js 의 LOBBY_WORLD_W / H, LOBBY_WALK_PX_PER_SEC 와 같아야 함)
const WORLD_W = 1500;
const WORLD_H = 1100;
const WALK_PX_PER_SEC = 160;
// 걸어 다닐 수 있는 섬 안쪽 (비율)
const WALK_MIN_X = 0.05, WALK_MAX_X = 0.95, WALK_MIN_Y = 0.07, WALK_MAX_Y = 0.95;

// 황금 상자
// LOBBY_GOLDEN_GAP_MS 환경변수가 있으면 그 간격으로 (로컬 시험용, 운영에서는 넣지 마세요)
const GOLDEN_TEST_GAP_MS = Number(process.env.LOBBY_GOLDEN_GAP_MS) || 0;
const GOLDEN_MIN_GAP_MS = GOLDEN_TEST_GAP_MS || 3 * 60 * 1000;
const GOLDEN_MAX_GAP_MS = GOLDEN_TEST_GAP_MS || 6 * 60 * 1000;
const GOLDEN_LIFE_MS = 70 * 1000;
const GOLDEN_HP = 8;                    // 두드려야 하는 횟수 (같이 두드리면 빨리 열림)
const GOLDEN_STEP_MS = 3500;            // 이 간격마다 다음 자리로 걸어감
const GOLDEN_SPEED_PX_PER_SEC = 60;     // 사람보다 느리게 (따라잡을 수 있게)
const GOLDEN_WANDER_PX = 220;
const GOLDEN_TAP_RANGE_PX = 150;        // 이 거리 안에서만 두드릴 수 있음 (지연을 감안해 화면보다 조금 넉넉하게)
const GOLDEN_TAP_GAP_MS = 120;
const GOLDEN_GOLD_MINUTES = 15;
const GOLDEN_GOLD_MIN = 3000;
const GOLDEN_SHARDS = 5;

// 거대 황금 상자 레이드 (LOBBY_RAID_GAP_MS 환경변수는 로컬 시험용)
const RAID_TEST_GAP_MS = Number(process.env.LOBBY_RAID_GAP_MS) || 0;
const RAID_FIRST_MIN_MS = RAID_TEST_GAP_MS || 4 * 60 * 1000;   // 방이 열리고 첫 레이드까지
const RAID_FIRST_MAX_MS = RAID_TEST_GAP_MS || 6 * 60 * 1000;
const RAID_MIN_GAP_MS = RAID_TEST_GAP_MS || 8 * 60 * 1000;
const RAID_MAX_GAP_MS = RAID_TEST_GAP_MS || 12 * 60 * 1000;
const RAID_LIFE_MS = Number(process.env.LOBBY_RAID_LIFE_MS) || 90 * 1000; // 환경변수는 로컬 시험용
const RAID_HP_BASE = 30;
const RAID_HP_PER_PLAYER = 25;          // 방 인원이 많을수록 체력이 큼
const RAID_JUMPS = [0.6, 0.25];         // 체력이 이 비율 아래로 내려가면 도망
const RAID_JUMP_MS = 900;
const RAID_RANGE_BONUS_PX = 60;         // 큰 상자라 조금 멀리서도 닿음
const RAID_TAP_GAP_MS = 150;
const RAID_CRIT_CHANCE = 0.12;
const RAID_MIN_TAPS = 3;                // 이만큼은 두드려야 보상 (지나가다 한 번 누르고 받는 것 방지)
const RAID_GOLD_MINUTES = 20;
const RAID_GOLD_MIN = 5000;
const RAID_PARTY_BONUS = 0.1;           // 참가자 1명 늘 때마다 보상 +10%
const RAID_PARTY_BONUS_MAX = 1;         // 최대 +100% (2배)
const RAID_SHARDS = 8;
const RAID_MVP_SHARDS = 7;

// 초월 사냥 혜택: 초월 횟수 t 에 따라
function huntPerks(t) {
  const n = Math.max(0, Number(t) || 0);
  return {
    speedPct: Math.min(60, n * 3),             // 이동 속도 +3%씩 (최대 +60%)
    rangePx: Math.min(200, n * 10),            // 두드리는 사거리 +10씩 (최대 +200)
    damage: 1 + Math.min(4, Math.floor(n / 5)), // 한 번 두드릴 때 피해 (초월 5회마다 +1, 최대 5)
  };
}
function walkSpeedOf(info) {
  return WALK_PX_PER_SEC * (100 + huntPerks(info.transcend).speedPct) / 100;
}

// 방: { no, players: Map(userId → entry), chats: [], golden, goldenSpawnTimer, raid, raidSpawnTimer }
const rooms = Array.from({ length: ROOM_COUNT }, (_, i) => ({
  no: i + 1, players: new Map(), chats: [], golden: null, goldenSpawnTimer: null, raid: null, raidSpawnTimer: null,
}));
const sockets = new Map();   // userId → entry { ws, info, room(방 객체 또는 null) }
let wss = null;
let goldenSeq = 0;
let raidSeq = 0;
let chatSeq = 0;
let roomsTimer = null;
const muteCache = new Map(); // userId → { muted, at }

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data, exceptId = null) {
  const text = JSON.stringify(data);
  for (const [id, p] of room.players) {
    if (id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(text);
  }
}
function roomList() {
  return rooms.map(r => ({ no: r.no, count: r.players.size, max: ROOM_CAPACITY }));
}
function sendRooms(entry) {
  send(entry.ws, { t: 'rooms', rooms: roomList(), current: entry.room ? entry.room.no : null });
}
// 방 인원이 바뀌면 모두에게 목록을 다시 보냅니다. (1초에 한 번으로 묶어서)
function scheduleRoomsBroadcast() {
  if (roomsTimer) return;
  roomsTimer = setTimeout(() => {
    roomsTimer = null;
    for (const entry of sockets.values()) sendRooms(entry);
  }, ROOMS_BROADCAST_MS);
}
function firstOpenRoom() {
  return rooms.find(r => r.players.size < ROOM_CAPACITY) || null;
}
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
const rand = (min, max) => min + Math.random() * (max - min);

// 움직임 { x0, y0, x1, y1, t0, dur } 에서 지금 위치 (비율)
function posAt(m, now = Date.now()) {
  if (!m.dur) return { x: m.x1, y: m.y1 };
  const k = Math.min(1, Math.max(0, (now - m.t0) / m.dur));
  return { x: m.x0 + (m.x1 - m.x0) * k, y: m.y0 + (m.y1 - m.y0) * k };
}
function distPx(a, b) {
  return Math.hypot((a.x - b.x) * WORLD_W, (a.y - b.y) * WORLD_H);
}
// 지금 자리에서 (x, y)로 걸어가는 움직임을 시작합니다. 반환: 걸리는 시간(ms)
function startWalk(m, x, y, speedPxPerSec, now = Date.now()) {
  const cur = posAt(m, now);
  const dur = Math.round(distPx(cur, { x, y }) / speedPxPerSec * 1000);
  Object.assign(m, { x0: cur.x, y0: cur.y, x1: x, y1: y, t0: now, dur });
  return dur;
}

// 이름 옆 표시 정보: 닉네임 · 초월 횟수 · 수집가 칭호
async function loadProfile(userId) {
  const result = await db.query('SELECT nickname, transcend_count FROM users WHERE id = $1', [userId]);
  if (!result.rows[0]) return null;
  // routes/box.js 가 이 파일을 불러오므로, 순환 참조를 피하려고 쓸 때 불러옵니다.
  const { collectorTitlesFor } = require('../routes/box');
  const titles = await collectorTitlesFor([userId]);
  return {
    nickname: result.rows[0].nickname,
    transcend: Number(result.rows[0].transcend_count) || 0,
    title: titles[userId] ? { emoji: titles[userId].emoji, name: titles[userId].name } : null,
  };
}

// 화면에 보내는 사람 정보. 걷는 중이면 지금 위치에서 남은 길을 이어 걷도록 보냅니다.
function publicInfo(info, now = Date.now()) {
  const cur = posAt(info.motion, now);
  const left = Math.max(0, info.motion.t0 + info.motion.dur - now);
  return {
    id: info.id, nickname: info.nickname, transcend: info.transcend, title: info.title,
    x: cur.x, y: cur.y, tx: info.motion.x1, ty: info.motion.y1, dur: left, speed: walkSpeedOf(info),
  };
}

function goldenPublic(golden, now = Date.now()) {
  if (!golden) return null;
  const cur = posAt(golden.motion, now);
  return {
    id: golden.id, x: cur.x, y: cur.y, tx: golden.motion.x1, ty: golden.motion.y1,
    dur: Math.max(0, golden.motion.t0 + golden.motion.dur - now),
    hp: golden.hp, maxHp: GOLDEN_HP, endsInMs: Math.max(0, golden.endsAt - now),
  };
}

// -------------------------------
// 황금 상자
// -------------------------------
function scheduleGolden(room) {
  clearTimeout(room.goldenSpawnTimer);
  room.goldenSpawnTimer = setTimeout(() => spawnGolden(room), rand(GOLDEN_MIN_GAP_MS, GOLDEN_MAX_GAP_MS));
}
function spawnGolden(room) {
  room.goldenSpawnTimer = null;
  if (room.golden) return;
  if (room.players.size === 0) return; // 빈 방에는 띄우지 않음 (누가 들어오면 다시 예약)
  if (room.raid) { scheduleGolden(room); return; } // 레이드 중에는 작은 상자를 띄우지 않음
  const x = rand(0.12, 0.88);
  const y = rand(0.15, 0.88);
  const now = Date.now();
  const golden = room.golden = {
    id: ++goldenSeq,
    motion: { x0: x, y0: y, x1: x, y1: y, t0: now, dur: 0 },
    hp: GOLDEN_HP,
    tappers: new Set(),
    lastTapAt: new Map(),
    endsAt: now + GOLDEN_LIFE_MS,
  };
  golden.stepTimer = setInterval(() => wanderGolden(room), GOLDEN_STEP_MS);
  golden.endTimer = setTimeout(() => endGolden(room, 'gone'), GOLDEN_LIFE_MS);
  broadcast(room, { t: 'gspawn', g: goldenPublic(golden, now) });
}
function wanderGolden(room) {
  const golden = room.golden;
  if (!golden) return;
  const cur = posAt(golden.motion);
  const angle = Math.random() * Math.PI * 2;
  const reach = rand(GOLDEN_WANDER_PX * 0.4, GOLDEN_WANDER_PX);
  const x = clamp(cur.x + Math.cos(angle) * reach / WORLD_W, 0.1, 0.9);
  const y = clamp(cur.y + Math.sin(angle) * reach / WORLD_H, 0.13, 0.9);
  const dur = startWalk(golden.motion, x, y, GOLDEN_SPEED_PX_PER_SEC);
  broadcast(room, { t: 'gmove', x, y, dur });
}
function endGolden(room, reason) {
  const box = room.golden;
  if (!box) return;
  room.golden = null;
  clearInterval(box.stepTimer);
  clearTimeout(box.endTimer);
  if (reason === 'open') {
    const winners = [...box.tappers];
    broadcast(room, { t: 'gopen', by: winners });
    for (const userId of winners) {
      grantGolden(userId)
        .then(reward => {
          const entry = sockets.get(userId); // 그 사이 방을 옮겼어도 보상 알림은 받음
          if (reward && entry) send(entry.ws, { t: 'greward', ...reward });
        })
        .catch(err => console.error(`[LOBBY] 황금 상자 보상 실패 user=${userId} · ${describeError(err)}`));
    }
  } else {
    broadcast(room, { t: 'ggone' });
  }
  if (room.players.size > 0) scheduleGolden(room);
}
function tapGolden(room, userId, info) {
  const golden = room.golden;
  if (!golden) return;
  const now = Date.now();
  if (now - (golden.lastTapAt.get(userId) || 0) < GOLDEN_TAP_GAP_MS) return;
  golden.lastTapAt.set(userId, now);
  if (distPx(posAt(info.motion, now), posAt(golden.motion, now)) > GOLDEN_TAP_RANGE_PX + huntPerks(info.transcend).rangePx) {
    const entry = sockets.get(userId);
    if (entry) send(entry.ws, { t: 'gfar' });
    return;
  }
  golden.tappers.add(userId);
  golden.hp -= 1;
  broadcast(room, { t: 'ghit', by: userId, hp: golden.hp });
  if (golden.hp <= 0) endGolden(room, 'open');
}

// 두드린 사람의 지금 모드 세이브에 보상을 넣습니다.
function grantGolden(userId) {
  return grantReward(userId, { minutes: GOLDEN_GOLD_MINUTES, minGold: GOLDEN_GOLD_MIN, shards: GOLDEN_SHARDS });
}
// 골드 = max(minGold, 분당 수입 × minutes) × multiplier · 수집모드는 신화 조각도
async function grantReward(userId, { minutes, minGold, shards: collectionShards, multiplier = 1 }) {
  return withUserTransaction(userId, async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const save = await store.settle(client, userId, mode);
    if (!save) return null;
    const gold = Math.floor(Math.max(minGold, save.income.perMinuteIncome * minutes) * multiplier);
    const fields = {
      total_treasure: save.claim.total_treasure + gold,
      run_gold_earned: Number(save.claim.run_gold_earned) + gold,
    };
    let shards = 0;
    if (mode === MODES.COLLECTION) {
      shards = collectionShards;
      fields.mythic_shards = (Number(save.claim.mythic_shards) || 0) + shards;
    }
    await store.updateClaim(client, userId, mode, fields);
    return { gold, shards, mode, totalTreasure: fields.total_treasure };
  });
}

// -------------------------------
// 거대 황금 상자 레이드
// -------------------------------
function raidPublic(raid, now = Date.now()) {
  if (!raid) return null;
  const cur = posAt(raid.motion, now);
  return {
    id: raid.id, x: cur.x, y: cur.y, tx: raid.motion.x1, ty: raid.motion.y1,
    dur: Math.max(0, raid.motion.t0 + raid.motion.dur - now),
    hp: raid.hp, maxHp: raid.maxHp, endsInMs: Math.max(0, raid.endsAt - now), party: raid.damage.size,
  };
}
function scheduleRaid(room, first = false) {
  clearTimeout(room.raidSpawnTimer);
  const gap = first ? rand(RAID_FIRST_MIN_MS, RAID_FIRST_MAX_MS) : rand(RAID_MIN_GAP_MS, RAID_MAX_GAP_MS);
  room.raidSpawnTimer = setTimeout(() => spawnRaid(room), gap);
}
function spawnRaid(room) {
  room.raidSpawnTimer = null;
  if (room.raid || room.players.size === 0) return;
  const now = Date.now();
  const x = 0.5, y = 0.4; // 분수 광장 위쪽
  const maxHp = RAID_HP_BASE + RAID_HP_PER_PLAYER * room.players.size;
  const raid = room.raid = {
    id: ++raidSeq,
    motion: { x0: x, y0: y, x1: x, y1: y, t0: now, dur: 0 },
    hp: maxHp, maxHp,
    damage: new Map(),   // userId → 준 피해
    taps: new Map(),     // userId → 두드린 횟수
    lastTapAt: new Map(),
    jumpsDone: 0,
    endsAt: now + RAID_LIFE_MS,
  };
  raid.endTimer = setTimeout(() => endRaid(room, false), RAID_LIFE_MS);
  broadcast(room, { t: 'rspawn', r: raidPublic(raid, now) });
}
// 체력이 일정 비율 아래로 내려가면 섬 다른 곳(지금 자리에서 멀리)으로 도망
function jumpRaid(room) {
  const raid = room.raid;
  const cur = posAt(raid.motion);
  let x = cur.x, y = cur.y;
  for (let i = 0; i < 12; i++) {
    x = rand(0.15, 0.85); y = rand(0.2, 0.85);
    if (distPx(cur, { x, y }) >= 320) break;
  }
  Object.assign(raid.motion, { x0: cur.x, y0: cur.y, x1: x, y1: y, t0: Date.now(), dur: RAID_JUMP_MS });
  broadcast(room, { t: 'rmove', x, y, dur: RAID_JUMP_MS, jump: true });
}
function tapRaid(room, userId, info) {
  const raid = room.raid;
  if (!raid) return;
  const now = Date.now();
  if (now - (raid.lastTapAt.get(userId) || 0) < RAID_TAP_GAP_MS) return;
  raid.lastTapAt.set(userId, now);
  const perks = huntPerks(info.transcend);
  if (distPx(posAt(info.motion, now), posAt(raid.motion, now)) > GOLDEN_TAP_RANGE_PX + RAID_RANGE_BONUS_PX + perks.rangePx) {
    const entry = sockets.get(userId);
    if (entry) send(entry.ws, { t: 'gfar' });
    return;
  }
  const crit = Math.random() < RAID_CRIT_CHANCE;
  const dmg = Math.min(raid.hp, perks.damage * (crit ? 2 : 1));
  raid.hp -= dmg;
  raid.damage.set(userId, (raid.damage.get(userId) || 0) + dmg);
  raid.taps.set(userId, (raid.taps.get(userId) || 0) + 1);
  broadcast(room, { t: 'rhit', by: userId, dmg, crit, hp: raid.hp, party: raid.damage.size });
  if (raid.hp <= 0) { endRaid(room, true); return; }
  const next = RAID_JUMPS[raid.jumpsDone];
  if (next !== undefined && raid.hp <= raid.maxHp * next) {
    raid.jumpsDone += 1;
    jumpRaid(room);
  }
}
function endRaid(room, success) {
  const raid = room.raid;
  if (!raid) return;
  room.raid = null;
  clearTimeout(raid.endTimer);
  const ranking = [...raid.damage.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, dmg]) => ({ id, nickname: sockets.get(id)?.info.nickname || '?', dmg }));
  const qualified = ranking.filter(r => (raid.taps.get(r.id) || 0) >= RAID_MIN_TAPS);
  const mvp = success && qualified.length ? qualified[0].id : null;
  const partyBonus = Math.min(RAID_PARTY_BONUS_MAX, RAID_PARTY_BONUS * Math.max(0, qualified.length - 1));
  broadcast(room, {
    t: 'rend', success, ranking: ranking.slice(0, 5), party: qualified.length, mvp,
    bonusPct: Math.round(partyBonus * 100), minTaps: RAID_MIN_TAPS, total: raid.maxHp,
  });
  if (success) {
    for (const r of qualified) {
      const isMvp = r.id === mvp;
      grantReward(r.id, {
        minutes: RAID_GOLD_MINUTES, minGold: RAID_GOLD_MIN,
        shards: RAID_SHARDS + (isMvp ? RAID_MVP_SHARDS : 0), multiplier: 1 + partyBonus,
      })
        .then(reward => {
          const entry = sockets.get(r.id);
          if (reward && entry) send(entry.ws, { t: 'rreward', ...reward, mvp: isMvp, share: Math.round(r.dmg / raid.maxHp * 100) });
        })
        .catch(err => console.error(`[LOBBY] 레이드 보상 실패 user=${r.id} · ${describeError(err)}`));
    }
  }
  if (room.players.size > 0) scheduleRaid(room);
}

// -------------------------------
// 신고
// -------------------------------
async function isMuted(userId) {
  const cached = muteCache.get(userId);
  if (cached && Date.now() - cached.at < MUTE_CACHE_MS) return cached.muted;
  const result = await db.query(
    `SELECT COUNT(DISTINCT reporter_id) AS n FROM user_reports
     WHERE target_id = $1 AND created_at > NOW() - $2::interval`,
    [userId, MUTE_WINDOW]
  );
  const muted = Number(result.rows[0].n) >= MUTE_REPORTERS;
  muteCache.set(userId, { muted, at: Date.now() });
  return muted;
}
async function saveReport(entry, msg) {
  const room = entry.room;
  const reporterId = entry.info.id;
  let targetId = null;
  let context = 'lobby_user';
  let message = null;
  if (msg.cid !== undefined) {
    // 화면이 보낸 글이 아니라 서버가 가진 채팅 기록에서 찾습니다. (지어낸 내용으로 신고할 수 없게)
    const chat = room && room.chats.find(c => c.cid === Number(msg.cid));
    if (!chat) return '이미 지나간 채팅이라 신고할 수 없습니다. 사용자를 눌러 신고해 주십시오.';
    targetId = chat.id;
    context = 'lobby_chat';
    message = chat.text;
  } else {
    targetId = Number(msg.id);
    if (!room || !room.players.has(targetId)) return '같은 방에 있는 사람만 신고할 수 있습니다.';
  }
  if (targetId === reporterId) return '나 자신은 신고할 수 없습니다.';
  await db.query(
    'INSERT INTO user_reports (reporter_id, target_id, context, message) VALUES ($1, $2, $3, $4)',
    [reporterId, targetId, context, message]
  );
  muteCache.delete(targetId);
  console.warn(`[REPORT] ${context} reporter=${reporterId} target=${targetId}${message ? ` · "${message}"` : ''}`);
  return null;
}

// 방에 넣습니다. (자리가 있는지는 부르는 쪽에서 확인)
// 처음 들어오면 섬 가운데 광장 근처에서 시작하고, 방을 옮길 때도 새 방의 광장에서 시작합니다.
function enterRoom(entry, room) {
  const { info, ws } = entry;
  // 분수(섬 가운데 x 0.5, y 0.55) 둘레의 광장 바닥 어딘가
  const angle = Math.random() * Math.PI * 2;
  const reach = rand(85, 130);
  const start = { x: 0.5 + Math.cos(angle) * reach / WORLD_W, y: 0.55 + Math.sin(angle) * reach / WORLD_H };
  info.motion = { x0: start.x, y0: start.y, x1: start.x, y1: start.y, t0: Date.now(), dur: 0 };
  entry.room = room;
  room.players.set(info.id, entry);
  if (!room.golden && !room.goldenSpawnTimer) scheduleGolden(room);
  if (!room.raid && !room.raidSpawnTimer) scheduleRaid(room, true);

  const now = Date.now();
  send(ws, {
    t: 'init', room: room.no, me: info.id, world: { w: WORLD_W, h: WORLD_H, speed: WALK_PX_PER_SEC },
    players: [...room.players.values()].map(p => publicInfo(p.info, now)),
    chats: room.chats, golden: goldenPublic(room.golden, now), raid: raidPublic(room.raid, now),
    perks: { ...huntPerks(info.transcend), baseRangePx: GOLDEN_TAP_RANGE_PX, raidRangeBonusPx: RAID_RANGE_BONUS_PX },
  });
  broadcast(room, { t: 'join', p: publicInfo(info) }, info.id);
  scheduleRoomsBroadcast();
}
function leaveRoom(entry) {
  const room = entry.room;
  if (!room) return;
  entry.room = null;
  if (room.players.get(entry.info.id) === entry) {
    room.players.delete(entry.info.id);
    broadcast(room, { t: 'leave', id: entry.info.id });
  }
  // 아무도 없는 방은 황금 상자 예약을 멈춥니다. (나와 있던 상자는 70초 뒤 저절로 사라짐)
  if (room.players.size === 0) {
    clearTimeout(room.goldenSpawnTimer);
    room.goldenSpawnTimer = null;
    clearTimeout(room.raidSpawnTimer);
    room.raidSpawnTimer = null;
  }
  scheduleRoomsBroadcast();
}

// -------------------------------
// 연결
// -------------------------------
async function onConnection(ws, req) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let userId;
  try {
    const token = new URL(req.url, 'http://lobby').searchParams.get('token');
    userId = verifyTokenString(token).userId;
  } catch (err) {
    ws.close(4001, 'auth');
    return;
  }

  // 같은 계정이 다른 창에서 다시 들어오면 예전 연결은 닫습니다. (그 자리를 비우고 새 연결이 씀)
  const previous = sockets.get(userId);
  if (!previous && sockets.size >= MAX_SOCKETS) {
    ws.close(4003, 'full');
    return;
  }

  let profile;
  try {
    profile = await loadProfile(userId);
  } catch (err) {
    console.error(`[LOBBY] 프로필을 불러오지 못했습니다 user=${userId} · ${err.message}`);
  }
  if (!profile || ws.readyState !== ws.OPEN) {
    ws.close(4002, 'profile');
    return;
  }
  const current = sockets.get(userId);
  const preferredRoom = current && current.room;
  if (current) {
    leaveRoom(current);
    sockets.delete(userId);
    current.ws.close(4004, 'replaced');
  }

  const info = { id: userId, ...profile, motion: null, lastMoveAt: 0, lastChatAt: 0, lastRoomAt: 0 };
  const entry = { ws, info, room: null };
  sockets.set(userId, entry);

  // 다른 창에서 있던 방이 있으면 그 방으로, 아니면 1번방부터 자리가 있는 방으로.
  const room = (preferredRoom && preferredRoom.players.size < ROOM_CAPACITY) ? preferredRoom : firstOpenRoom();
  sendRooms(entry);
  if (room) enterRoom(entry, room);
  else send(ws, { t: 'allfull' }); // 목록 화면에서 대기 (자리가 나면 rooms 로 알려줌)

  ws.on('message', (raw) => {
    if (raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (err) { return; }
    if (!msg || typeof msg !== 'object') return;
    const t = Date.now();

    if (msg.t === 'room') {
      // 방 옮기기 / 목록에서 들어가기
      if (t - info.lastRoomAt < 800) return;
      info.lastRoomAt = t;
      const target = rooms[Math.floor(Number(msg.no)) - 1];
      if (!target) return;
      if (entry.room === target) { sendRooms(entry); return; }
      if (target.players.size >= ROOM_CAPACITY) {
        send(ws, { t: 'notice', text: `${target.no}번방이 가득 찼습니다.` });
        sendRooms(entry);
        return;
      }
      leaveRoom(entry);
      enterRoom(entry, target);
      return;
    }

    const room = entry.room;
    if (!room) return; // 방에 들어가기 전(목록 대기 중)에는 이동·채팅 없음

    if (msg.t === 'report') {
      if (t - (info.lastReportAt || 0) < REPORT_GAP_MS) return;
      info.lastReportAt = t;
      saveReport(entry, msg)
        .then(error => send(ws, { t: 'notice', text: error || '신고했습니다. 운영자가 확인합니다. 원하면 차단도 할 수 있습니다.', ok: !error }))
        .catch(err => {
          console.error(`[LOBBY] 신고 저장 실패 user=${userId} · ${describeError(err)}`);
          send(ws, { t: 'notice', text: '신고를 저장하지 못했습니다. 잠시 후 다시 시도해 주십시오.' });
        });
      return;
    }

    if (msg.t === 'move') {
      if (t - info.lastMoveAt < MOVE_GAP_MS) return;
      info.lastMoveAt = t;
      const x = clamp(msg.x, WALK_MIN_X, WALK_MAX_X);
      const y = clamp(msg.y, WALK_MIN_Y, WALK_MAX_Y);
      const dur = startWalk(info.motion, x, y, walkSpeedOf(info), t);
      broadcast(room, { t: 'move', id: userId, x, y, dur });
    } else if (msg.t === 'gtap') {
      tapGolden(room, userId, info);
    } else if (msg.t === 'rtap') {
      tapRaid(room, userId, info);
    } else if (msg.t === 'chat') {
      const text = typeof msg.text === 'string' ? msg.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) return;
      if (t - info.lastChatAt < CHAT_GAP_MS) {
        send(ws, { t: 'notice', text: '채팅이 너무 빠릅니다. 조금 천천히 입력해 주십시오.' });
        return;
      }
      info.lastChatAt = t;
      const chat = {
        cid: ++chatSeq,
        id: userId,
        nickname: info.nickname,
        transcend: info.transcend,
        text: [...text].slice(0, CHAT_MAX_LENGTH).join(''),
        at: new Date(t).toISOString(),
      };
      // 신고가 쌓인 사람은 잠시 채팅을 막습니다. (DB 확인이 끝난 뒤에 보냄)
      isMuted(userId)
        .catch(() => false)
        .then(muted => {
          if (muted) {
            send(ws, { t: 'notice', text: '신고가 여러 번 접수되어 잠시 광장 채팅을 쓸 수 없습니다.' });
            return;
          }
          if (entry.room !== room) return; // 그 사이 방을 옮김
          room.chats.push(chat);
          if (room.chats.length > CHAT_HISTORY) room.chats.shift();
          broadcast(room, { t: 'chat', c: chat });
        });
    }
  });

  ws.on('close', () => {
    if (sockets.get(userId) !== entry) return; // 다른 창으로 바뀐 예전 연결
    leaveRoom(entry);
    sockets.delete(userId);
  });
  ws.on('error', () => {});
}

// server.js 에서 HTTP 서버를 만든 뒤 한 번 호출합니다.
function attachLobby(server) {
  wss = new WebSocketServer({ server, path: '/lobby', maxPayload: MAX_MESSAGE_BYTES });
  wss.on('connection', (ws, req) => {
    onConnection(ws, req).catch(err => {
      console.error(`[LOBBY] 연결 처리 오류 · ${err.message}`);
      ws.close(1011, 'error');
    });
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(timer));
  console.log('[LOBBY] 광장 WebSocket 준비 완료 (/lobby)');
}

// 초월 등으로 이름 옆 정보가 바뀌었을 때, 광장에 있는 사람들에게 바로 반영합니다.
async function refreshPlayer(userId) {
  const entry = sockets.get(userId);
  if (!entry) return;
  const profile = await loadProfile(userId);
  if (!profile) return;
  Object.assign(entry.info, profile);
  if (entry.room) broadcast(entry.room, { t: 'update', p: publicInfo(entry.info) });
  // 초월 사냥 혜택도 바로 갱신
  send(entry.ws, { t: 'perks', perks: { ...huntPerks(entry.info.transcend), baseRangePx: GOLDEN_TAP_RANGE_PX, raidRangeBonusPx: RAID_RANGE_BONUS_PX } });
}

module.exports = { attachLobby, refreshPlayer, CHAT_MAX_LENGTH };
