'use strict';

/**
 * sync-sheet.js
 * スプレッドシートA → B 同期 + AI分類（カテゴリ①②・Notion載せない）
 *
 * 処理:
 *   1. スプレッドシートA から全件取得 → FUND_ID でフィルタ
 *   2. スプレッドシートB に同じ URL がある行はスキップ（重複排除）
 *   3. 過去データからカテゴリ等を継承
 *   4. カテゴリ未入力の新着を Claude API で自動分類
 *   5. スプレッドシートB に追記（分類結果含む）
 *   6. Slack 通知
 *
 * 環境変数:
 *   FUND_ID, SPREADSHEET_A_ID, SPREADSHEET_A_SHEET,
 *   SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON,
 *   ANTHROPIC_API_KEY, SLACK_WEBHOOK_URL
 */

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── 環境変数 ──────────────────────────────────────────────────────────
const FUND_ID = process.env.FUND_ID;
const SPREADSHEET_A_ID = process.env.SPREADSHEET_A_ID;
const SPREADSHEET_A_SHEET = process.env.SPREADSHEET_A_SHEET || '2026年度データベース';
const SPREADSHEET_B_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!SPREADSHEET_A_ID || !SPREADSHEET_B_ID || !SERVICE_ACCOUNT_JSON) {
  console.error('[ERROR] 必要な環境変数が不足: SPREADSHEET_A_ID, SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

// ── スプレッドシート列定義 ──────────────────────────────────────────────
const COL_A_DEFAULT = { 取得日時: 0, ステルス: 1, No: 2, 会社名: 3, 公開日: 4, タイトル: 5, 詳細: 6, リンク: 7, 配信ステータス: 8 };
const COL_B_DEFAULT = { 日付: 0, No: 1, 会社名: 2, ステルス: 3, タイトル: 4, リンク: 5, 'カテゴリ①': 6, 'カテゴリ②': 7, 'Notion載せない': 8, LINKS: 9, 掲載月: 10 };

// ── Google 認証 ────────────────────────────────────────────────────────
let credentials;
try { credentials = JSON.parse(SERVICE_ACCOUNT_JSON); } catch (e) {
  console.error('[ERROR] GOOGLE_SERVICE_ACCOUNT_JSON パース失敗:', e.message); process.exit(1);
}
const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

// ── ユーティリティ ────────────────────────────────────────────────────
const isValidNo = (no) => { if (!no || String(no).startsWith('L')) return false; const n = parseInt(no, 10); return !isNaN(n) && n >= 1000 && n < 3000; };
const getFund = (no) => { const n = parseInt(no, 10); if (n >= 1000 && n < 2000) return 'dct1'; if (n >= 2000 && n < 3000) return 'dct2'; return null; };
const toYYYYMM = (dateStr) => { if (!dateStr) return ''; const m = dateStr.match(/(\d{4})[\/\-\.](\d{1,2})/); return m ? `${m[1]}${String(m[2]).padStart(2, '0')}` : ''; };
const formatDate = (raw) => (raw ? raw.trim().split(' ')[0].replace(/\//g, '.') : '');
const buildColIdx = (headerRow, defaults) => { const idx = { ...defaults }; (headerRow || []).forEach((h, i) => { const name = h.trim(); if (name in idx) idx[name] = i; }); return idx; };
const getCell = (row, colIdx, name) => (row[colIdx[name]] !== undefined ? String(row[colIdx[name]]) : '').trim();

// ── AI 分類 ────────────────────────────────────────────────────────────

const CLASSIFY_MODEL = 'claude-sonnet-4-20250514';

const buildClassifyPrompt = (title, company, url) => `あなたはスタートアップ企業のニュースを分類するアシスタントです。

以下のニュースを読んで、カテゴリとLP掲載可否を判定してください。

会社名: ${company}
タイトル: ${title}
URL: ${url}

## カテゴリ①（大分類）- 必ず1つ選択
- 資金調達: 調達、ラウンド、クローズ、投資等
- 事業進捗: プロダクトリリース、パートナーシップ、導入事例等
- その他: 受賞、採択、特集記事、組織・人事、出版等

## カテゴリ②（小分類）

カテゴリ①が「資金調達」→ 空欄

カテゴリ①が「事業進捗」→ 以下から1つ:
- プロダクト: 新製品・サービス・機能のリリース、提供開始、アップデート
- パートナーシップ: 他社との提携、協業、共同開発、共同研究、契約締結、ファンド設立
- 導入事例: 他社での製品導入、利用開始、実証実験、累計導入数の節目達成

カテゴリ①が「その他」→ 以下から1つ:
- 特集: メディア掲載、記事公開、インタビュー、TV出演、動画公開、イベント出展・登壇（新製品の出展はプロダクト）
- 受賞・採択: アワード受賞、コンテスト入賞、政府プログラム採択、認定、特許取得
- 出版・発信: 書籍出版、レポート公開、セミナー開催、イベント主催
- 組織・人事: 人事異動、組織変更、新体制、ISO等の認証取得、拠点開設、商号変更

## 判断が難しいケース
- 複数要素 → 最も主要な要素で判断（例:「提携で新サービス開始」→パートナーシップ）
- 特許取得 → 受賞・採択
- ISO認証 → 組織・人事
- 導入社数の節目 → 導入事例
- 実証実験 → 導入事例
- 共同開発・共同研究 → パートナーシップ

## LP掲載可否（notionExclude）の判定ルール

STEP 1: カテゴリ①が「資金調達」→ 0（確定）

STEP 2: タイトルに以下を含む → 1
  開催、登壇、出展、セミナー、ウェビナー、無料公開、無料配布、ガイド、レポート、資料、キャンペーン、プロモーション、アーカイブ、移転、リニューアル、アップデート情報

STEP 3: URLがprtimes.jp以外 かつ カテゴリ①が「その他」→ 1

STEP 4: 導入事例の場合 → 導入先が上場企業・業界大手なら0、中小・スタートアップなら1

STEP 5: パートナーシップの場合 → 戦略提携・共同開発なら0、販売代理店・取次なら1

STEP 6: 受賞・採択の場合 → 主要経済紙（週刊東洋経済、日経、Forbes等）の選出なら0

STEP 7: 出版・発信でセミナー告知の内容 → 1

上記いずれにも該当しない → 0

## 出力形式（JSONのみ、説明文不要）
{
  "cat1": "資金調達|事業進捗|その他",
  "cat2": "プロダクト|パートナーシップ|導入事例|特集|受賞・採択|出版・発信|組織・人事|",
  "notionExclude": 0,
  "reason": "判断理由を一文"
}`;

const VALID_CAT1 = ['資金調達', '事業進捗', 'その他'];

async function classifyItem(anthropic, title, company, url) {
  try {
    const msg = await anthropic.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: buildClassifyPrompt(title, company, url) }],
    });
    const text = msg.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON not found');
    const json = JSON.parse(jsonMatch[0]);
    return {
      cat1: VALID_CAT1.includes(json.cat1) ? json.cat1 : 'その他',
      cat2: (typeof json.cat2 === 'string' ? json.cat2.trim() : '') || '',
      notionExclude: json.notionExclude === 1 ? '1' : '',
      reason: json.reason || '',
    };
  } catch (e) {
    console.warn(`  [WARN] 分類失敗: ${e.message}`);
    return { cat1: 'その他', cat2: '', notionExclude: '', reason: '' };
  }
}

// ── Slack 通知 ────────────────────────────────────────────────────────

async function sendSlack(payload) {
  if (!SLACK_WEBHOOK_URL) { console.log('[INFO] SLACK_WEBHOOK_URL 未設定、通知スキップ'); return; }
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    if (res.ok) console.log('[INFO] Slack 通知を送信しました');
    else console.warn(`[WARN] Slack 通知失敗: HTTP ${res.status}`);
  } catch (e) { console.warn('[WARN] Slack 通知エラー:', e.message); }
}

// ── メイン処理 ───────────────────────────────────────────────────────

async function main() {
  const fundLabel = FUND_ID ? FUND_ID.toUpperCase() : '全ファンド';
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // ===== 1. スプレッドシートA を読み込む =====
  console.log(`[INFO] スプレッドシートA「${SPREADSHEET_A_SHEET}」を読み込み中...`);
  let resA;
  try {
    resA = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_A_ID, range: `'${SPREADSHEET_A_SHEET}'!A:I` });
  } catch (e) { console.error('[ERROR] スプレッドシートA の読み込みに失敗:', e.message); process.exit(1); }

  const rowsA = resA.data.values || [];
  if (rowsA.length < 2) { console.log('[INFO] スプレッドシートA にデータがありません'); return; }

  const colIdxA = buildColIdx(rowsA[0], COL_A_DEFAULT);
  const getA = (row, name) => getCell(row, colIdxA, name);

  const allFromA = rowsA.slice(1)
    .map((row) => ({ No: getA(row, 'No'), 会社名: getA(row, '会社名'), ステルス: getA(row, 'ステルス'), 公開日: getA(row, '公開日'), タイトル: getA(row, 'タイトル'), リンク: getA(row, 'リンク') }))
    .filter((r) => isValidNo(r.No) && r.タイトル && r.リンク);

  const targetFromA = FUND_ID ? allFromA.filter((r) => getFund(r.No) === FUND_ID) : allFromA;
  console.log(`[INFO] スプレッドシートA: 全 ${allFromA.length} 件中、対象 ${targetFromA.length} 件`);

  // ===== 2. スプレッドシートB を読み込む =====
  console.log('[INFO] スプレッドシートB を読み込み中...');
  let resB;
  try {
    resB = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_B_ID, range: 'A:K' });
  } catch (e) { console.error('[ERROR] スプレッドシートB の読み込みに失敗:', e.message); process.exit(1); }

  const rowsB = resB.data.values || [];
  const colIdxB = buildColIdx(rowsB[0] || [], COL_B_DEFAULT);
  const getB = (row, name) => getCell(row, colIdxB, name);

  const existingB = rowsB.slice(1).map((row) => ({
    No: getB(row, 'No'), リンク: getB(row, 'リンク'), タイトル: getB(row, 'タイトル'),
    'カテゴリ①': getB(row, 'カテゴリ①'), 'カテゴリ②': getB(row, 'カテゴリ②'), 'Notion載せない': getB(row, 'Notion載せない'),
  }));
  console.log(`[INFO] スプレッドシートB: 既存 ${existingB.length} 件`);

  // ===== 3. 重複チェック =====
  const existingUrls = new Set(existingB.map((r) => r.リンク).filter(Boolean));
  const existingTitles = new Set(existingB.map((r) => r.タイトル).filter(Boolean));

  // ===== 4. 過去データ参照マップ =====
  const pastByNo = {};
  for (const row of existingB) {
    if (row.No) {
      pastByNo[row.No] = {
        'カテゴリ①': row['カテゴリ①'] || pastByNo[row.No]?.['カテゴリ①'] || '',
        'カテゴリ②': row['カテゴリ②'] || pastByNo[row.No]?.['カテゴリ②'] || '',
        'Notion載せない': row['Notion載せない'] === '1' ? '1' : (pastByNo[row.No]?.['Notion載せない'] || ''),
      };
    }
  }

  // ===== 5. 新着ニュースの抽出 =====
  const newItems = targetFromA.filter((r) => !existingUrls.has(r.リンク));
  console.log(`[INFO] 新着ニュース: ${newItems.length} 件`);

  if (newItems.length === 0) {
    console.log('[INFO] 追加する新着ニュースはありません');
    await sendSlack({ text: `📭 Portfolio News（${fundLabel}）: 新着ニュースなし`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*📭 新着ニュースなし（${fundLabel}）*\n追加対象のニュースはありませんでした。` } }] });
    return;
  }

  // ===== 6. AI分類（カテゴリ未入力の記事のみ） =====
  let anthropic = null;
  if (ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  } else {
    console.log('[INFO] ANTHROPIC_API_KEY 未設定、AI分類をスキップ');
  }

  const classifiedItems = []; // 分類結果を保持
  const seenTitles = new Set(existingTitles); // 重複タイトル検出用

  for (const item of newItems) {
    const past = pastByNo[item.No] || {};
    let cat1 = past['カテゴリ①'] || '';
    let cat2 = past['カテゴリ②'] || '';
    let notionExclude = past['Notion載せない'] || '';
    let reason = '';

    // 同一タイトル重複 → 2件目以降は除外
    const isDuplicate = seenTitles.has(item.タイトル.trim());
    seenTitles.add(item.タイトル.trim());

    if (isDuplicate) {
      notionExclude = '1';
      reason = '同一タイトル重複';
      console.log(`[INFO] 重複検出（除外）: ${item.会社名} - ${item.タイトル.slice(0, 40)}...`);
    }

    // カテゴリ未入力 → AI分類
    if (!cat1 && anthropic) {
      console.log(`[INFO] AI分類中: ${item.会社名} - ${item.タイトル.slice(0, 50)}...`);
      const result = await classifyItem(anthropic, item.タイトル, item.会社名, item.リンク);
      cat1 = result.cat1;
      cat2 = result.cat2;
      if (!isDuplicate) notionExclude = result.notionExclude;
      reason = reason || result.reason;
      await new Promise((r) => setTimeout(r, 300)); // レート制限
    }

    classifiedItems.push({ ...item, cat1, cat2, notionExclude, reason });
  }

  // ===== 7. 追記データを構築 =====
  const newRows = classifiedItems.map((item) => [
    formatDate(item.公開日),    // A: 日付
    item.No,                    // B: No
    item.会社名,                 // C: 会社名
    item.ステルス,               // D: ステルス
    item.タイトル,               // E: タイトル
    item.リンク,                 // F: リンク
    item.cat1,                  // G: カテゴリ①
    item.cat2,                  // H: カテゴリ②
    item.notionExclude,         // I: Notion載せない
    '',                          // J: LINKS
    toYYYYMM(item.公開日),       // K: 掲載月
  ]);

  // ===== 8. スプレッドシートB に追記 =====
  console.log(`[INFO] スプレッドシートB に ${newRows.length} 件を追記します...`);
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_B_ID,
      range: 'A:K',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows },
    });
    console.log('[INFO] スプレッドシートB への追記が完了しました');
  } catch (e) {
    console.error('[ERROR] スプレッドシートB への書き込みに失敗:', e.message);
    process.exit(1);
  }

  // ===== 9. サマリーをファイルに保存 =====
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sync-result.json'), JSON.stringify({ fundId: FUND_ID, addedCount: classifiedItems.length, items: classifiedItems }, null, 2), 'utf-8');

  // ===== 10. Slack 通知 =====
  const sheetBUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_B_ID}/edit`;
  const actionsBaseUrl = FUND_ID === 'dct1'
    ? 'https://github.com/KarinYOSHIDA02/portfolio-news-dct1/actions/workflows/generate.yml'
    : 'https://github.com/KarinYOSHIDA02/portfolio-news-dct2/actions/workflows/generate.yml';

  const maxDisplay = 15;
  const itemLines = classifiedItems.slice(0, maxDisplay).map((item, i) => {
    const catLabel = item.cat1 ? `[${item.cat1}${item.cat2 ? `/${item.cat2}` : ''}]` : '[未分類]';
    const excludeMark = item.notionExclude === '1' ? ' ⚠️除外' : '';
    return `${i + 1}. *${item.会社名}* ${catLabel}${excludeMark}\n   ${item.タイトル}`;
  });
  if (classifiedItems.length > maxDisplay) {
    itemLines.push(`_...他 ${classifiedItems.length - maxDisplay} 件_`);
  }

  const excludeCount = classifiedItems.filter(i => i.notionExclude === '1').length;

  await sendSlack({
    text: `📰 Portfolio News（${fundLabel}）: ${classifiedItems.length}件追加（${excludeCount}件除外判定）`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `📰 新着 ${classifiedItems.length}件 追加・AI分類完了（${fundLabel}）`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `スプレッドシートBに追加し、AI分類を実行しました。\n掲載: *${classifiedItems.length - excludeCount}件* / 除外判定: *${excludeCount}件*\n\n確認・修正後、*「▶️ HTML生成を実行」*ボタンを押してください。` } },
      { type: 'section', text: { type: 'mrkdwn', text: itemLines.join('\n\n') } },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '💡 *確認ポイント*: カテゴリ・Notion載せない・掲載月 を確認し、必要に応じて修正してください。' }] },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '📊 スプレッドシートを確認', emoji: true }, url: sheetBUrl, style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: '▶️ HTML生成を実行', emoji: true }, url: actionsBaseUrl },
      ] },
    ],
  });

  console.log(`[INFO] 完了: ${classifiedItems.length} 件を追加（AI分類済み）`);
}

main().catch((err) => { console.error('[ERROR]', err); process.exit(1); });
