// game/season.js
// 시즌(매주)과 오늘(매일) 계산입니다. 둘 다 한국 시간 오전 9시(= 00:00 UTC)에 바뀝니다.
//
// - 시즌(매주 목요일): 기록모드 초기화 · 랭킹 시즌
// - 오늘(매일): 상자에서 나오는 신화 10종과 오늘의 규칙. 10일이면 신화 100종이 한 바퀴 돕니다.
// - 둘 다 DB에 저장하지 않고 "지금 시각"으로 계산합니다. (서버를 켜두지 않아도 정확함)
// - 시즌이 바뀐 뒤 유저가 처음 접속하면(정산할 때) 그 유저의 세이브에 새 시즌이 적용됩니다. (store.settle)

const { ROTATION_COUNT } = require('./mythics');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// 매일 바뀌는 신화·규칙의 기준일: 2026-10-14 09:00 KST = 0일째 (신화 묶음 0번)
const DAILY_ANCHOR = Date.UTC(2026, 9, 14, 0, 0, 0);
// 주간 시즌 기준점: 2026-10-15(목) 09:00 KST = 00:00 UTC. 이때부터 시즌 3이 시작됩니다.
// 그 전(시즌 2)은 30만 골드 랭킹 시즌으로, 이 시점에 끝납니다.
const WEEKLY_SEASON_ANCHOR = Date.UTC(2026, 9, 15, 0, 0, 0);
const FIRST_WEEKLY_SEASON = 3;
const PRE_WEEKLY_SEASON = FIRST_WEEKLY_SEASON - 1;

function getSeason(now = new Date()) {
  const t = now instanceof Date ? now.getTime() : now;
  if (t < WEEKLY_SEASON_ANCHOR) return PRE_WEEKLY_SEASON;
  return FIRST_WEEKLY_SEASON + Math.floor((t - WEEKLY_SEASON_ANCHOR) / WEEK_MS);
}

// 시즌이 시작/끝나는 시각 (시즌 2 이전은 시작 시각을 따로 기록하지 않아서 null)
function getSeasonStart(season) {
  if (season < FIRST_WEEKLY_SEASON) return null;
  return new Date(WEEKLY_SEASON_ANCHOR + (season - FIRST_WEEKLY_SEASON) * WEEK_MS);
}
function getSeasonEnd(season) {
  if (season < PRE_WEEKLY_SEASON) return null;
  return new Date(WEEKLY_SEASON_ANCHOR + (season - PRE_WEEKLY_SEASON) * WEEK_MS);
}

// 오늘이 기준일로부터 며칠째인지 (매일 오전 9시에 1씩 늘어남)
function getDay(now = new Date()) {
  const t = now instanceof Date ? now.getTime() : now;
  return Math.floor((t - DAILY_ANCHOR) / DAY_MS);
}
function getDayStart(day) {
  return new Date(DAILY_ANCHOR + day * DAY_MS);
}
function getDayEnd(day) {
  return new Date(DAILY_ANCHOR + (day + 1) * DAY_MS);
}

// 오늘 상자에서 나오는 신화 묶음 번호 (0~9)
function getRotation(day) {
  return ((day % ROTATION_COUNT) + ROTATION_COUNT) % ROTATION_COUNT;
}

// 이 묶음이 다음에 나오는 날 (오늘이 그 묶음이면 오늘)
function getNextDayForRotation(rotation, today) {
  const diff = (rotation - getRotation(today) + ROTATION_COUNT) % ROTATION_COUNT;
  return today + diff;
}

module.exports = {
  WEEK_MS,
  FIRST_WEEKLY_SEASON,
  getSeason,
  getSeasonStart,
  getSeasonEnd,
  getDay,
  getDayStart,
  getDayEnd,
  getRotation,
  getNextDayForRotation,
};
