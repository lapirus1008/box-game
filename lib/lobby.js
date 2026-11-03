// lib/lobby.js
// 광장(대기실): 로그인한 사람끼리 상자 캐릭터로 돌아다니며 짧게 채팅합니다.
// - WebSocket 주소: wss://<서버>/lobby?token=<로그인 토큰>
// - 상태는 서버 메모리에만 둡니다. (DB에 저장하지 않음, 서버가 재시작되면 비워짐 · Render 서버 한 대 기준)
// - 위치는 0~1 비율로 주고받아서 화면 크기가 달라도 같은 자리에 보입니다.
//
// 받는 메시지(화면 → 서버)
//   { t: 'move', x, y }      이동할 자리
//   { t: 'chat', text }      채팅 (CHAT_MAX_LENGTH자까지)
// 보내는 메시지(서버 → 화면)
//   { t: 'init', me, players, chats }   접속 직후 전체 상태
//   { t: 'join', p } / { t: 'leave', id } / { t: 'update', p }
//   { t: 'move', id, x, y } / { t: 'chat', c } / { t: 'notice', text }

const { WebSocketServer } = require('ws');
const db = require('../db');
const { verifyTokenString } = require('./token');

const MAX_PLAYERS = 60;
const CHAT_MAX_LENGTH = 60;
const CHAT_HISTORY = 30;
const CHAT_GAP_MS = 1500;        // 채팅은 1.5초에 한 번
const MOVE_GAP_MS = 120;         // 이동은 0.12초에 한 번
const PING_INTERVAL_MS = 30000;  // 끊긴 연결 정리 (응답 없는 연결은 다음 확인 때 닫음)
const MAX_MESSAGE_BYTES = 512;

const players = new Map(); // userId → { ws, info }
const chats = [];
let wss = null;

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(data, exceptId = null) {
  const text = JSON.stringify(data);
  for (const [id, p] of players) {
    if (id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(text);
  }
}
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

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

function publicInfo(info) {
  return { id: info.id, nickname: info.nickname, transcend: info.transcend, title: info.title, x: info.x, y: info.y };
}

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

  const info = {
    id: userId,
    ...profile,
    x: previous ? previous.info.x : 0.15 + Math.random() * 0.7,
    y: previous ? previous.info.y : 0.35 + Math.random() * 0.5,
    lastMoveAt: 0,
    lastChatAt: 0,
  };
  const entry = { ws, info, replaced: false };
  players.set(userId, entry);

  send(ws, { t: 'init', me: userId, players: [...players.values()].map(p => publicInfo(p.info)), chats });
  if (previous) broadcast({ t: 'update', p: publicInfo(info) }, userId);
  else broadcast({ t: 'join', p: publicInfo(info) }, userId);

  ws.on('message', (raw) => {
    if (raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (err) { return; }
    if (!msg || typeof msg !== 'object') return;
    const now = Date.now();

    if (msg.t === 'move') {
      if (now - info.lastMoveAt < MOVE_GAP_MS) return;
      info.lastMoveAt = now;
      info.x = clamp01(msg.x);
      info.y = clamp01(msg.y);
      broadcast({ t: 'move', id: userId, x: info.x, y: info.y });
    } else if (msg.t === 'chat') {
      const text = typeof msg.text === 'string' ? msg.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) return;
      if (now - info.lastChatAt < CHAT_GAP_MS) {
        send(ws, { t: 'notice', text: '조금 천천히 말해 주세요.' });
        return;
      }
      info.lastChatAt = now;
      const chat = {
        id: userId,
        nickname: info.nickname,
        transcend: info.transcend,
        text: [...text].slice(0, CHAT_MAX_LENGTH).join(''),
        at: new Date(now).toISOString(),
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
