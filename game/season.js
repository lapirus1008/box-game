// game/season.js
// 주간 시즌 계산입니다. 시즌은 매주 목요일 오전 9시(한국 시간)에 바뀝니다.
//
// - 시즌 번호는 DB에 따로 저장하지 않고 "지금 시각"으로 계산합니다. (서버를 켜두지 않아도 정확함)
// - 시즌이 바뀐 뒤 유저가 처음 접속하면(정산할 때) 그 유저의 세이브에 새 시즌이 적용됩니다. (store.settle)
// - 시즌마다 신화 10종이 돌아가며 나옵니다. 10주가 지나면 처음 10종부터 다시 나옵니다.

const { ROTATION_COUNT } = require('./mythics');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
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

// 이 시즌에 나오는 신화 묶음 번호 (0~9). 시즌 2(지금)부터 0번 묶음으로 시작합니다.
function getRotation(season) {
  return (((season - PRE_WEEKLY_SEASON) % ROTATION_COUNT) + ROTATION_COUNT) % ROTATION_COUNT;
}

// 지금 이후로 이 묶음이 처음 나오는 시즌 (지금 시즌이 그 묶음이면 지금 시즌)
function getNextSeasonForRotation(rotation, currentSeason) {
  const diff = (rotation - getRotation(currentSeason) + ROTATION_COUNT) % ROTATION_COUNT;
  return currentSeason + diff;
}

module.exports = {
  WEEK_MS,
  FIRST_WEEKLY_SEASON,
  getSeason,
  getSeasonStart,
  getSeasonEnd,
  getRotation,
  getNextSeasonForRotation,
};
