// scripts/render-store-assets.js
// 앱 아이콘(PNG)과 플레이스토어 등록용 그래픽을 만듭니다.
//
// 실행: npx playwright 가 설치된 환경에서  node scripts/render-store-assets.js
//  (Playwright는 게임 서버에 필요 없어서 package.json 에 넣지 않았습니다.
//   없으면: npm i -D playwright && npx playwright install chromium)
//
// 결과
//  - public/icons/app/icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png (게임·설치용)
//  - store/icon-512.png        : 플레이스토어 앱 아이콘 (512×512)
//  - store/feature-graphic.png : 플레이스토어 그래픽 이미지 (1024×500)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { defs, DRAW, PALETTES, sparkle } = require('./generate-icons');
const { MYTHICS } = require('../game/mythics');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'public', 'icons', 'app');
const STORE_DIR = path.join(ROOT, 'store');

// 앱 아이콘: 남색 배경 + 분홍 후광 + 황금 보물상자. scale로 상자 크기를 정합니다.
// (maskable 아이콘은 가장자리가 잘릴 수 있어서 상자를 더 작게 그립니다)
function appIconSvg(scale) {
  const p = PALETTES.gold;
  const offset = 64 - 64 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="512" height="512">
${defs(p, 'mythic')}
<defs>
  <radialGradient id="bg" cx=".5" cy=".42" r=".75"><stop offset="0" stop-color="#3a2a86"/><stop offset=".55" stop-color="#1a1c45"/><stop offset="1" stop-color="#0b1220"/></radialGradient>
  <radialGradient id="halo" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ff5fc8" stop-opacity=".75"/><stop offset=".55" stop-color="#ff5fc8" stop-opacity=".2"/><stop offset="1" stop-color="#ff5fc8" stop-opacity="0"/></radialGradient>
</defs>
<rect width="128" height="128" fill="url(#bg)"/>
<circle cx="64" cy="66" r="${56 * scale}" fill="url(#halo)"/>
<g transform="translate(${offset} ${offset + 2}) scale(${scale})">${DRAW.chest(p)}</g>
${sparkle(64 - 40 * scale, 64 - 38 * scale, 7 * scale, '#ffd6f2')}
${sparkle(64 + 42 * scale, 64 + 36 * scale, 5 * scale, '#ffffff')}
</svg>`;
}

// 그래픽 이미지(1024×500): 제목 + 상자 + 신화 아이콘들
function featureGraphicHtml() {
  const picks = ['ancient_crown', 'astral_compass', 'galaxy_orb', 'dragon_pearl', 'flame_wing', 'gold_key', 'storm_sword', 'blossom_moon'];
  const iconUrl = key => 'file://' + path.join(ROOT, 'public', 'icons', 'items', `${key}.svg`);
  const pos = [[60, 40, 120], [200, 290, 110], [40, 300, 92], [210, 60, 86], [820, 40, 112], [690, 300, 104], [880, 290, 96], [700, 70, 84]];
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{ margin:0; }
  .fg{ position:relative; width:1024px; height:500px; overflow:hidden;
       background:radial-gradient(ellipse at 50% 45%, #3a2a86 0%, #1a1c45 55%, #0b1220 100%);
       font-family:'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif; color:#fff; }
  .chest{ position:absolute; left:392px; top:96px; width:240px; height:240px; }
  .title{ position:absolute; left:0; right:0; top:340px; text-align:center; font-size:64px; font-weight:800; letter-spacing:4px;
          color:#ffe9a8; text-shadow:0 4px 0 #8a5c0b, 0 0 30px rgba(255,95,200,.6); }
  .sub{ position:absolute; left:0; right:0; top:430px; text-align:center; font-size:24px; color:#f2d6ff; letter-spacing:1px; }
  .ic{ position:absolute; filter:drop-shadow(0 0 12px rgba(255,95,200,.55)); }
</style></head><body><div class="fg">
  ${picks.map((k, i) => `<img class="ic" src="${iconUrl(k)}" style="left:${pos[i][0]}px; top:${pos[i][1]}px; width:${pos[i][2]}px">`).join('')}
  <img class="chest" src="file://${path.join(APP_DIR, 'chest-only.svg')}">
  <div class="title">시간의 상자</div>
  <div class="sub">신화 ${MYTHICS.length}종 수집 · 매주 목요일 새 시즌</div>
</div></body></html>`;
}

function chestOnlySvg() {
  const p = PALETTES.gold;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${defs(p, 'mythic')}<circle cx="64" cy="64" r="62" fill="url(#glow)"/>${DRAW.chest(p)}</svg>`;
}

async function main() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(APP_DIR, 'icon.svg'), appIconSvg(0.82));
  fs.writeFileSync(path.join(APP_DIR, 'icon-maskable.svg'), appIconSvg(0.62));
  fs.writeFileSync(path.join(APP_DIR, 'chest-only.svg'), chestOnlySvg());
  const featurePath = path.join(STORE_DIR, 'feature-graphic.html');
  fs.writeFileSync(featurePath, featureGraphicHtml());

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  const shoot = async (file, size, out) => {
    // SVG 파일을 바로 열고, 창 크기에 꽉 차게 맞춰서 찍습니다.
    await page.setViewportSize({ width: size, height: size });
    await page.goto('file://' + file);
    await page.evaluate((px) => {
      const svg = document.querySelector('svg');
      svg.setAttribute('width', px);
      svg.setAttribute('height', px);
      document.documentElement.style.margin = '0';
    }, size);
    await page.waitForTimeout(200);
    await page.screenshot({ path: out });
  };
  await shoot(path.join(APP_DIR, 'icon.svg'), 192, path.join(APP_DIR, 'icon-192.png'));
  await shoot(path.join(APP_DIR, 'icon.svg'), 512, path.join(APP_DIR, 'icon-512.png'));
  await shoot(path.join(APP_DIR, 'icon-maskable.svg'), 512, path.join(APP_DIR, 'icon-maskable-512.png'));
  fs.copyFileSync(path.join(APP_DIR, 'icon-512.png'), path.join(STORE_DIR, 'icon-512.png'));

  await page.setViewportSize({ width: 1024, height: 500 });
  await page.goto('file://' + featurePath);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(STORE_DIR, 'feature-graphic.png') });
  await browser.close();
  fs.unlinkSync(featurePath);
  console.log('[STORE] 앱 아이콘과 그래픽 이미지를 만들었습니다.');
}

main().catch(err => { console.error(err); process.exit(1); });
