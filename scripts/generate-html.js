'use strict';

/**
 * generate-html.js
 * data/news-cache.json のデータを templates/index.template.html に埋め込み、
 * docs/index.html（最新月）と docs/archives/YYYYMM.html（月別アーカイブ）を生成する
 *
 * 必要な環境変数:
 *   FUND_ID - 'dct1' または 'dct2'
 */

const fs = require('fs');
const path = require('path');

const FUND_ID = process.env.FUND_ID || 'dct1';
const FUND_LABEL = FUND_ID === 'dct1' ? 'DEEPCORE TOKYO 1号ファンド' : 'DEEPCORE TOKYO 2号ファンド';

/**
 * YYYYMM → "YYYY年M月" に変換
 */
function getMonthLabel(ym) {
  const y = ym.slice(0, 4);
  const m = parseInt(ym.slice(4), 10);
  return `${y}年${m}月`;
}

/**
 * テンプレートにデータを注入して HTML 文字列を生成する
 *
 * @param {string} template - テンプレート HTML 文字列
 * @param {object} options
 * @param {Array}  options.items      - 当月のニュース配列
 * @param {string} options.month      - 当月 YYYYMM
 * @param {string[]} options.sortedMonths - 全月を新しい順に並べた配列
 * @param {boolean} options.isIndex   - docs/index.html として生成するか
 */
function generatePage(template, { items, month, sortedMonths, isIndex }) {
  const monthIdx = sortedMonths.indexOf(month);

  // 新しい方向 (next) = 配列上でインデックスが小さい
  // 古い方向 (prev) = 配列上でインデックスが大きい
  const newerMonth = monthIdx > 0 ? sortedMonths[monthIdx - 1] : null;
  const olderMonth = monthIdx < sortedMonths.length - 1 ? sortedMonths[monthIdx + 1] : null;

  let prevUrl = null; // 古い月（← ボタン）
  let nextUrl = null; // 新しい月（→ ボタン）

  if (isIndex) {
    // docs/index.html からのリンク
    prevUrl = olderMonth ? `archives/${olderMonth}.html` : null;
    nextUrl = null; // index が最新なので → は無効
  } else {
    // docs/archives/YYYYMM.html からのリンク（archives/ 内の相対パス）
    prevUrl = olderMonth ? `${olderMonth}.html` : null;
    nextUrl = newerMonth ? `${newerMonth}.html` : null;
  }

  // 安全な文字列置換（$ 記号などを含む JSON でも壊れないよう関数を使う）
  const inject = (tmpl, marker, value) =>
    tmpl.replace(new RegExp(marker, 'g'), () => value);

  let html = template;
  html = inject(html, '__FUND_LABEL__', FUND_LABEL);
  html = inject(html, '__FUND_ID__', FUND_ID);
  html = inject(html, '__CURRENT_MONTH__', month);
  html = inject(html, '__MONTH_LABEL__', getMonthLabel(month));
  html = inject(html, '__NEWS_ITEMS_JSON__', JSON.stringify(items));
  html = inject(html, '__PREV_URL_JSON__', JSON.stringify(prevUrl));
  html = inject(html, '__NEXT_URL_JSON__', JSON.stringify(nextUrl));

  return html;
}

async function main() {
  const cachePath = path.join(process.cwd(), 'data', 'news-cache.json');

  if (!fs.existsSync(cachePath)) {
    console.error('[ERROR] data/news-cache.json が見つかりません。fetch-sheet.js を先に実行してください。');
    process.exit(1);
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

  // TARGET_MONTHS でフィルタ（例: "202602" or "202601,202602"）
  const targetMonths = process.env.TARGET_MONTHS
    ? process.env.TARGET_MONTHS.split(',').map(m => m.trim()).filter(Boolean)
    : null;

  if (targetMonths && targetMonths.length > 0) {
    console.log(`[INFO] 対象月フィルタ: ${targetMonths.join(', ')}`);
    for (const key of Object.keys(cache)) {
      if (!targetMonths.includes(key)) delete cache[key];
    }
  }

  const months = Object.keys(cache);

  if (months.length === 0) {
    console.error('[ERROR] 対象月のデータがありません');
    process.exit(1);
  }

  const templatePath = path.join(process.cwd(), 'templates', 'index.template.html');
  if (!fs.existsSync(templatePath)) {
    console.error('[ERROR] templates/index.template.html が見つかりません');
    process.exit(1);
  }

  const template = fs.readFileSync(templatePath, 'utf-8');

  // docs/ 以下のディレクトリを準備
  const docsDir = path.join(process.cwd(), 'docs');
  const archivesDir = path.join(docsDir, 'archives');
  fs.mkdirSync(archivesDir, { recursive: true });

  // 月を新しい順に並べる（例: ['202601', '202512', '202511']）
  const sortedMonths = [...months].sort().reverse();
  const latestMonth = sortedMonths[0];

  // docs/index.html（最新月）を生成
  const indexHtml = generatePage(template, {
    items: cache[latestMonth] || [],
    month: latestMonth,
    sortedMonths,
    isIndex: true,
  });
  fs.writeFileSync(path.join(docsDir, 'index.html'), indexHtml, 'utf-8');
  console.log(`[INFO] 生成: docs/index.html (${latestMonth} / ${getMonthLabel(latestMonth)})`);

  // docs/archives/YYYYMM.html を全月分生成
  for (const month of sortedMonths) {
    const archiveHtml = generatePage(template, {
      items: cache[month] || [],
      month,
      sortedMonths,
      isIndex: false,
    });
    const archivePath = path.join(archivesDir, `${month}.html`);
    fs.writeFileSync(archivePath, archiveHtml, 'utf-8');
    console.log(`[INFO] 生成: docs/archives/${month}.html (${getMonthLabel(month)})`);
  }

  console.log('[INFO] HTML 生成完了');
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
