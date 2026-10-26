// game/skills.js
// 신화 스킬: 신화의 효과 종류(9가지)마다 직접 눌러 쓰는 능력이 하나씩 있습니다.
// - 그 종류의 신화를 가지고 있으면 열립니다. (기록모드: 이번 판 보유 · 수집모드: 신화 도감)
// - 가진 신화 중 가장 높은 단계(Ⅰ~Ⅳ)가 스킬 위력을 정합니다.
// - 수집모드에서는 그 종류 신화의 가장 높은 각성 ★마다 대기시간 -10%, 도감 80종 달성 시 추가 -20%.

const { MYTHICS } = require('./mythics');

const SKILL_BASE_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const SKILL_COOLDOWN_PER_STAR = 0.1;
const SKILL_BUFF_MS = 10 * 60 * 1000; // 행운·할인 같은 시간제 효과 지속 시간

// t = 가진 신화 중 가장 높은 단계 (1~4)
const SKILLS = [
  { type: 'incomePercent',    emoji: '💰', name: '황금 러시',   desc: t => `${3 + 2 * t}분간 수입 2배` },
  { type: 'chargeSpeed',      emoji: '⚡', name: '즉시 충전',   desc: t => `상자 충전 +${25 * t}개` },
  { type: 'golden',           emoji: '🎁', name: '황금 소환',   desc: () => '지금 바로 황금 상자 등장' },
  { type: 'luck',             emoji: '🍀', name: '행운의 손길', desc: t => `10분간 희귀 이상 등장률 +${10 * t}%` },
  { type: 'pity',             emoji: '🌸', name: '운명의 실',   desc: t => `신화 천장 게이지 +${100 * t}` },
  { type: 'boxDiscount',      emoji: '🏷️', name: '떨이',       desc: t => `10분간 상자 구매가 -${10 + 5 * t}%` },
  { type: 'upgradeDiscount',  emoji: '🔨', name: '장인의 손',   desc: t => (t >= 4 ? '다음 강화 1회 무료' : `다음 강화 1회 비용 -${25 * t}%`) },
  { type: 'autoOpenDiscount', emoji: '⏳', name: '시간 비축',   desc: t => `자동 개봉 +${30 * t}분` },
  { type: 'storageMinutes',   emoji: '📦', name: '시간 되감기', desc: t => `수입 ${15 * t}분치 즉시 획득` },
];
const SKILL_BY_TYPE = Object.fromEntries(SKILLS.map(s => [s.type, s]));

// 스킬마다 열려 있는지, 위력(단계), 대기시간, 다시 쓸 수 있는 시각
// have(key): 이 신화를 가지고 있는지 / awaken: 각성 기록(수집모드) / cooldownBonus: 마일스톤 대기시간 감소(0~1)
function getSkillStates({ have, awaken = {}, cooldowns = {}, cooldownBonus = 0, now }) {
  return SKILLS.map(skill => {
    const mine = MYTHICS.filter(m => m.effect.type === skill.type && have(m.key));
    const tier = mine.reduce((best, m) => Math.max(best, m.tier), 0);
    const stars = mine.reduce((best, m) => Math.max(best, Number(awaken[m.key]) || 0), 0);
    const factor = Math.max(0.2, (1 - stars * SKILL_COOLDOWN_PER_STAR) * (1 - cooldownBonus));
    const cooldownMs = Math.round(SKILL_BASE_COOLDOWN_MS * factor);
    const readyAt = cooldowns[skill.type] ? new Date(cooldowns[skill.type]) : null;
    const remainingMs = readyAt ? Math.max(0, readyAt - now) : 0;
    return {
      type: skill.type,
      emoji: skill.emoji,
      name: skill.name,
      unlocked: tier > 0,
      tier,
      stars,
      desc: skill.desc(Math.max(1, tier)),
      cooldownMs,
      remainingMs,
      ready: tier > 0 && remainingMs === 0,
    };
  });
}

// 시간제 스킬 효과(행운·할인)가 지금 적용 중이면 그 값을 돌려줍니다.
function activeSkillBuffs(buffs = {}, now = Date.now()) {
  const t = typeof now === 'number' ? now : now.getTime();
  return {
    luck: buffs.luckUntil && new Date(buffs.luckUntil).getTime() > t ? Number(buffs.luckValue) || 0 : 0,
    boxDiscount: buffs.discountUntil && new Date(buffs.discountUntil).getTime() > t ? Number(buffs.discountValue) || 0 : 0,
    upgradeDiscount: Number(buffs.upgradeDiscount) || 0,
  };
}

module.exports = {
  SKILLS,
  SKILL_BY_TYPE,
  SKILL_BUFF_MS,
  getSkillStates,
  activeSkillBuffs,
};
