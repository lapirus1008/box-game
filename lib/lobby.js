// lib/lobby.js
// 광장(대기실): 로그인한 사람끼리 넓은 지형 위를 상자 캐릭터로 돌아다니며 짧게 채팅합니다.
// - WebSocket 주소: wss://<서버>/lobby?token=<로그인 토큰>
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
// 보내는 메시지(서버 → 화면)
//   { t: 'init', me, players, chats, golden }   접속 직후 전체 상태
//   { t: 'join', p } / { t: 'leave', id } / { t: 'update', p } / { t: 'move', id, x, y, dur }
//   { t: 'chat', c } / { t: 'notice', text }
//   { t: 'gspawn', g } / { t: 'gmove', x, y, dur } / { t: 'ghit', by, hp } / { t: 'gfar' }
//   { t: 'gopen', by: [id...] } / { t: 'ggone' } / { t: 'greward', gold, shards }

const { WebSocketServer } = require('ws');
const db = require('../db');
const { verifyTokenString } = require('./token');
const { withUserTransaction, describeError } = require('./http');
const store = require('../game/store');
const { MODES } = require('../game/config');

const MAX_PLAYERS = 60;
const CHAT_MAX_LENGTH = 60;
const CHAT_HISTORY = 30;
const CHAT_GAP_MS = 1500;        // 채팅은 1.5초에 한 번
const MOVE_GAP_MS = 120;         // 이동은 0.12초에 한 번
const PING_INTERVAL_MS = 30000;  // 끊긴 연결 정리 (응답 없는 연결은 다음 확인 때 닫음)
const MAX_MESSAGE_BYTES = 512;

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

const players = new Map(); // userId → { ws, info }
const chats = [];
let wss = null;
let golden = null;           // 지금 나와 있는 황금 상자
let goldenSpawnTimer = null;
let goldenSeq = 0;

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(data, exceptId = null) {
  const text = JSON.stringify(data);
  for (const [id, p] of players) {
    if (id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(text);
  }
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
    x: cur.x, y: cur.y, tx: info.motion.x1, ty: info.motion.y1, dur: left,
  };
}

function goldenPublic(now = Date.now()) {
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
function scheduleGolden() {
  clearTimeout(goldenSpawnTimer);
  goldenSpawnTimer = setTimeout(spawnGolden, rand(GOLDEN_MIN_GAP_MS, GOLDEN_MAX_GAP_MS));
}
function spawnGolden() {
  if (golden) return;
  if (players.size === 0) { scheduleGolden(); return; } // 아무도 없으면 다음 기회에
  const x = rand(0.12, 0.88);
  const y = rand(0.15, 0.88);
  const now = Date.now();
  golden = {
    id: ++goldenSeq,
    motion: { x0: x, y0: y, x1: x, y1: y, t0: now, dur: 0 },
    hp: GOLDEN_HP,
    tappers: new Set(),
    lastTapAt: new Map(),
    endsAt: now + GOLDEN_LIFE_MS,
  };
  golden.stepTimer = setInterval(wanderGolden, GOLDEN_STEP_MS);
  golden.endTimer = setTimeout(() => endGolden('gone'), GOLDEN_LIFE_MS);
  broadcast({ t: 'gspawn', g: goldenPublic(now) });
}
function wanderGolden() {
  if (!golden) return;
  const cur = posAt(golden.motion);
  const angle = Math.random() * Math.PI * 2;
  const reach = rand(GOLDEN_WANDER_PX * 0.4, GOLDEN_WANDER_PX);
  const x = clamp(cur.x + Math.cos(angle) * reach / WORLD_W, 0.1, 0.9);
  const y = clamp(cur.y + Math.sin(angle) * reach / WORLD_H, 0.13, 0.9);
  const dur = startWalk(golden.motion, x, y, GOLDEN_SPEED_PX_PER_SEC);
  broadcast({ t: 'gmove', x, y, dur });
}
function endGolden(reason) {
  if (!golden) return;
  const box = golden;
  golden = null;
  clearInterval(box.stepTimer);
  clearTimeout(box.endTimer);
  if (reason === 'open') {
    const winners = [...box.tappers];
    broadcast({ t: 'gopen', by: winners });
    for (const userId of winners) {
      grantGolden(userId)
        .then(reward => {
          const entry = players.get(userId);
          if (reward && entry) send(entry.ws, { t: 'greward', ...reward });
        })
        .catch(err => console.error(`[LOBBY] 황금 상자 보상 실패 user=${userId} · ${describeError(err)}`));
    }
  } else {
    broadcast({ t: 'ggone' });
  }
  scheduleGolden();
}
function tapGolden(userId, info) {
  if (!golden) return;
  const now = Date.now();
  if (now - (golden.lastTapAt.get(userId) || 0) < GOLDEN_TAP_GAP_MS) return;
  golden.lastTapAt.set(userId, now);
  if (distPx(posAt(info.motion, now), posAt(golden.motion, now)) > GOLDEN_TAP_RANGE_PX) {
    const entry = players.get(userId);
    if (entry) send(entry.ws, { t: 'gfar' });
    return;
  }
  golden.tappers.add(userId);
  golden.hp -= 1;
  broadcast({ t: 'ghit', by: userId, hp: golden.hp });
  if (golden.hp <= 0) endGolden('open');
}

// 두드린 사람의 지금 모드 세이브에 보상을 넣습니다.
async function grantGolden(userId) {
  return withUserTransaction(userId, async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const save = await store.settle(client, userId, mode);
    if (!save) return null;
    const gold = Math.max(GOLDEN_GOLD_MIN, Math.floor(save.income.perMinuteIncome * GOLDEN_GOLD_MINUTES));
    const fields = {
      total_treasure: save.claim.total_treasure + gold,
      run_gold_earned: Number(save.claim.run_gold_earned) + gold,
    };
    let shards = 0;
    if (mode === MODES.COLLECTION) {
      shards = GOLDEN_SHARDS;
      fields.mythic_shards = (Number(save.claim.mythic_shards) || 0) + shards;
    }
    await store.updateClaim(client, userId, mode, fields);
    return { gold, shards, mode, totalTreasure: fields.total_treasure };
  });
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

  // 같은 계정이 다른 창에서 다시 들어오면 예전 연결은 닫습니다.
  const previous = players.get(userId);
  if (!previous && players.size >= MAX_PLAYERS) {
    send(ws, { t: 'full', max: MAX_PLAYERS });
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
  if (previous) {
    previous.replaced = true;
    previous.ws.close(4004, 'replaced');
  }

  // 처음 들어오면 섬 가운데 광장 근처에서 시작
  const start = previous ? posAt(previous.info.motion) : { x: rand(0.44, 0.56), y: rand(0.5, 0.6) };
  const info = {
    id: userId,
    ...profile,
    motion: { x0: start.x, y0: start.y, x1: start.x, y1: start.y, t0: Date.now(), dur: 0 },
    lastMoveAt: 0,
    lastChatAt: 0,
  };
  const entry = { ws, info, replaced: false };
  players.set(userId, entry);
  if (!golden && !goldenSpawnTimer) scheduleGolden();

  const now = Date.now();
  send(ws, {
    t: 'init', me: userId, world: { w: WORLD_W, h: WORLD_H, speed: WALK_PX_PER_SEC },
    players: [...players.values()].map(p => publicInfo(p.info, now)), chats, golden: goldenPublic(now),
  });
  if (previous) broadcast({ t: 'update', p: publicInfo(info) }, userId);
  else broadcast({ t: 'join', p: publicInfo(info) }, userId);

  ws.on('message', (raw) => {
    if (raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (err) { return; }
    if (!msg || typeof msg !== 'object') return;
    const t = Date.now();

    if (msg.t === 'move') {
      if (t - info.lastMoveAt < MOVE_GAP_MS) return;
      info.lastMoveAt = t;
      const x = clamp(msg.x, WALK_MIN_X, WALK_MAX_X);
      const y = clamp(msg.y, WALK_MIN_Y, WALK_MAX_Y);
      const dur = startWalk(info.motion, x, y, WALK_PX_PER_SEC, t);
      broadcast({ t: 'move', id: userId, x, y, dur });
    } else if (msg.t === 'gtap') {
      tapGolden(userId, info);
    } else if (msg.t === 'chat') {
      const text = typeof msg.text === 'string' ? msg.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) return;
      if (t - info.lastChatAt < CHAT_GAP_MS) {
        send(ws, { t: 'notice', text: '조금 천천히 말해 주세요.' });
        return;
      }
      info.lastChatAt = t;
      const chat = {
        id: userId,
        nickname: info.nickname,
        transcend: info.transcend,
        text: [...text].slice(0, CHAT_MAX_LENGTH).join(''),
        at: new Date(t).toISOString(),
      };
      chats.push(chat);
      if (chats.length > CHAT_HISTORY) chats.shift();
      broadcast({ t: 'chat', c: chat });
    }
  });

  ws.on('close', () => {
    if (players.get(userId) === entry) {
      players.delete(userId);
      broadcast({ t: 'leave', id: userId });
    }
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
  const entry = players.get(userId);
  if (!entry) return;
  const profile = await loadProfile(userId);
  if (!profile) return;
  Object.assign(entry.info, profile);
  broadcast({ t: 'update', p: publicInfo(entry.info) });
}

module.exports = { attachLobby, refreshPlayer, CHAT_MAX_LENGTH };
