// game/store.js
// 게임 데이터(box_claims, user_items, user_discoveries)를 읽고 쓰는 DB 함수 모음입니다.
// 모든 함수는 첫 인자로 runner를 받습니다. 트랜잭션 안이라면 client를, 아니라면 db를 넘기면 됩니다.
// (FOR UPDATE를 쓰는 함수는 반드시 BEGIN된 트랜잭션의 client를 넘겨야 합니다.)

const {
  DEFAULT_MODE,
  CHARGE_INTERVAL_MS,
  MAX_BOX_CHARGES,
  BASE_INCOME_PER_SECOND,
  INCOME_PER_SECOND_BY_RARITY,
  MASTERY_THRESHOLDS,
  MASTERY_INCOME_BONUS_PERCENT_PER_STAR,
  RESET_GOLD,
  TREASURES,
} = require('./config');
const { getItemStars } = require('./logic');

// 패시브 수입이 있는 아이템(전설/신화) 목록
const INCOME_ITEMS = TREASURES.filter(t => INCOME_PER_SECOND_BY_RARITY[t.rarity]);
const INCOME_ITEM_KEYS = INCOME_ITEMS.map(t => t.key);

// 이 요청 시점에 유저가 어떤 모드(기록/수집)를 쓰고 있는지 확인합니다.
async function getActiveMode(runner, userId) {
  const result = await runner.query('SELECT active_mode FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.active_mode || DEFAULT_MODE;
}

// 현재 모드의 box_claims 한 줄을 읽어옵니다. 없으면 null.
// columns는 코드 안에서 고정된 컬럼 목록만 넘겨야 합니다 (사용자 입력 금지).
async function getClaim(runner, userId, mode, columns, { forUpdate = false } = {}) {
  const result = await runner.query(
    `SELECT ${columns.join(', ')} FROM box_claims WHERE user_id = $1 AND mode = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, mode]
  );
  return result.rows[0] || null;
}

// 충전 개수를 최신 상태로 계산해서 필요하면 DB에 반영합니다. (동시 요청 안전성을 위해 FOR UPDATE 사용)
async function syncBoxCharges(client, userId, mode) {
  const claim = await getClaim(client, userId, mode, ['box_charges', 'last_charge_calculated_at'], { forUpdate: true });
  if (!claim) return null;

  const now = new Date();
  const lastCalc = new Date(claim.last_charge_calculated_at);
  const gained = Math.floor((now - lastCalc) / CHARGE_INTERVAL_MS);

  let charges = claim.box_charges;
  let newLastCalc = lastCalc;

  if (gained > 0) {
    charges = Math.min(MAX_BOX_CHARGES, charges + gained);
    newLastCalc = charges >= MAX_BOX_CHARGES ? now : new Date(lastCalc.getTime() + gained * CHARGE_INTERVAL_MS);

    await client.query(
      'UPDATE box_claims SET box_charges = $1, last_charge_calculated_at = $2 WHERE user_id = $3 AND mode = $4',
      [charges, newLastCalc, userId, mode]
    );
  }

  const nextChargeInMs = charges >= MAX_BOX_CHARGES ? null : CHARGE_INTERVAL_MS - (now - newLastCalc);

  return { charges, maxCharges: MAX_BOX_CHARGES, nextChargeInMs, serverTime: now };
}

// 전설/신화 아이템 각각의 숙련도(★)를 반영해서 초당 패시브 골드 수입을 계산합니다.
// 아이템 종류별로 개수가 다르기 때문에, "전설 전체 개수 × 고정 배율"이 아니라
// 아이템 하나하나마다 자기 보유 개수에 맞는 ★를 계산해서 그만큼 배율을 얹습니다.
async function computeIncomeBreakdown(runner, userId, mode) {
  const result = await runner.query(
    'SELECT item_key, count FROM user_items WHERE user_id = $1 AND mode = $2 AND item_key = ANY($3)',
    [userId, mode, INCOME_ITEM_KEYS]
  );
  const countMap = {};
  result.rows.forEach(row => { countMap[row.item_key] = parseInt(row.count, 10); });

  const totals = {
    legendary: { count: 0, income: 0 },
    mythic: { count: 0, income: 0 },
  };
  const items = [];

  for (const treasure of INCOME_ITEMS) {
    const count = countMap[treasure.key] || 0;
    if (count === 0) continue;

    const stars = getItemStars(count);
    // 초당 수입은 항상 정수로 맞춥니다 (★ 보너스로 생기는 소수점은 내림).
    // 0.1 같은 소수를 곱하면 부동소수점 오차가 생기므로 정수 퍼센트로 계산합니다.
    const bonusPercent = 100 + stars * MASTERY_INCOME_BONUS_PERCENT_PER_STAR;
    const itemIncome = Math.floor(count * INCOME_PER_SECOND_BY_RARITY[treasure.rarity] * bonusPercent / 100);

    totals[treasure.rarity].count += count;
    totals[treasure.rarity].income += itemIncome;
    items.push({
      key: treasure.key,
      name: treasure.name,
      emoji: treasure.emoji,
      rarity: treasure.rarity,
      count,
      stars,
      maxStars: MASTERY_THRESHOLDS.length,
      incomePerSecond: itemIncome,
    });
  }

  return {
    perSecondIncome: BASE_INCOME_PER_SECOND + totals.legendary.income + totals.mythic.income,
    baseIncome: BASE_INCOME_PER_SECOND,
    legendaryCount: totals.legendary.count,
    mythicCount: totals.mythic.count,
    legendaryIncome: totals.legendary.income,
    mythicIncome: totals.mythic.income,
    items, // 아이템별 개수/★/수입 상세 (도감 화면의 숙련도 표시용)
  };
}

// 마지막 정산 이후 쌓인 패시브 골드(기본 + 전설·신화 숙련도 보너스)를 계산해서 반영합니다.
async function collectPassiveIncome(client, userId, mode) {
  const claim = await getClaim(client, userId, mode, ['total_treasure', 'last_income_collected_at'], { forUpdate: true });
  if (!claim) return null;

  const now = new Date();
  const elapsedSeconds = (now - new Date(claim.last_income_collected_at)) / 1000;

  const breakdown = await computeIncomeBreakdown(client, userId, mode);
  const earned = Math.floor(elapsedSeconds * breakdown.perSecondIncome);
  const newTotal = parseInt(claim.total_treasure, 10) + earned;

  await client.query(
    'UPDATE box_claims SET total_treasure = $1, last_income_collected_at = $2 WHERE user_id = $3 AND mode = $4',
    [newTotal, now, userId, mode]
  );

  return { earned, newTotal, ...breakdown };
}

// 얻은 아이템들을 "보유 개수"(user_items)에 반영하고 발견 기록(user_discoveries)도 함께 남깁니다.
// counts는 { itemKey: 개수 } 형태입니다. 아이템 종류가 많아도 쿼리는 두 번만 실행됩니다.
// 발견 기록은
// - 기록모드: 이번 판 한정이라, 환생/초심으로 돌아가면 지워집니다.
// - 수집모드: 절대 지워지지 않는 영구 기록입니다.
// 같은 아이템을 또 발견해도 딱 한 번만 기록됩니다 (최초 발견일만 남김).
async function addItems(client, userId, mode, counts) {
  const keys = Object.keys(counts);
  if (keys.length === 0) return;
  const amounts = keys.map(key => counts[key]);

  await client.query(
    `INSERT INTO user_items (user_id, mode, item_key, count, first_obtained_at)
     SELECT $1, $2, t.item_key, t.amount, NOW()
     FROM unnest($3::text[], $4::int[]) AS t(item_key, amount)
     ON CONFLICT (user_id, mode, item_key)
     DO UPDATE SET count = user_items.count + EXCLUDED.count`,
    [userId, mode, keys, amounts]
  );
  await client.query(
    `INSERT INTO user_discoveries (user_id, mode, item_key, first_discovered_at)
     SELECT $1, $2, t.item_key, NOW()
     FROM unnest($3::text[]) AS t(item_key)
     ON CONFLICT (user_id, mode, item_key) DO NOTHING`,
    [userId, mode, keys]
  );
}

// 현재 모드의 세이브를 "이번 판" 처음 상태로 되돌립니다. (초심으로 돌아가기 / 환생 공용)
// 보유 아이템과 도감(발견기록)을 지우고, 골드·충전·천장·타이머를 초기화합니다.
async function resetSave(client, userId, mode, now, { rebirthCount } = {}) {
  await client.query('DELETE FROM user_items WHERE user_id = $1 AND mode = $2', [userId, mode]);
  await client.query('DELETE FROM user_discoveries WHERE user_id = $1 AND mode = $2', [userId, mode]);
  await client.query(
    `UPDATE box_claims
     SET total_treasure = $1,
         completion_bonus_claimed = FALSE,
         last_income_collected_at = $2,
         run_started_at = $2,
         box_charges = 1,
         last_charge_calculated_at = $2,
         mythic_pity = 0,
         rebirth_count = COALESCE($5, rebirth_count)
     WHERE user_id = $3 AND mode = $4`,
    [RESET_GOLD, now, userId, mode, rebirthCount ?? null]
  );
}

module.exports = {
  getActiveMode,
  getClaim,
  syncBoxCharges,
  computeIncomeBreakdown,
  collectPassiveIncome,
  addItems,
  resetSave,
};
