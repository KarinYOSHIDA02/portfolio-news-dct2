'use strict';

/**
 * classify.js
 * data/news-cache.json を読み込み、カテゴリ①・②が空欄の記事を
 * Claude API で自動分類し、Notion載せない判定も行う
 *
 * 必要な環境変数:
 *   ANTHROPIC_API_KEY - Anthropic API キー
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('[ERROR] ANTHROPIC_API_KEY が設定されていません');
  process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-20250514';

/**
 * 分類プロンプトを生成する
 */
const buildPrompt = (title, company, url) => `あなたはスタートアップ企業のニュースを分類するアシスタントです。

以下のニュースを読んで、カテゴリとLP掲載可否を判定してください。

会社名: ${company}
タイトル: ${title}
URL: ${url}

## カテゴリルール

### カテゴリ①（大分類）- 必ず1つ選択
- 資金調達: 調達、ラウンド、クローズ、投資等のキーワード
- 事業進捗: プロダクトリリース、パートナーシップ、導入事例等
- その他: 受賞、採択、特集記事、組織・人事、出版等

### カテゴリ②（小分類）
- 資金調達の場合: 空欄（選択不要）
- 事業進捗の場合: プロダクト / パートナーシップ / 導入事例 のいずれか1つ
- その他の場合: 特集 / 受賞・採択 / 出版・発信 / 組織・人事 のいずれか1つ

## LP掲載可否（notionExclude）の判定ルール

以下のSTEPを順に評価し、notionExclude を 0（掲載）または 1（除外）で判定してください。

STEP 1: カテゴリ①が「資金調達」→ notionExclude = 0（確定、以降のSTEPは無視）

STEP 2: タイトルに以下のキーワードが含まれる場合 → notionExclude = 1
  キーワード: 開催、登壇、出展、セミナー、ウェビナー、無料公開、無料配布、ガイド、レポート、資料、キャンペーン、プロモーション、アーカイブ、移転、リニューアル、アップデート情報

STEP 3: URLのドメインがprtimes.jp以外（自社ブログ・Wantedly等）かつカテゴリ①が「その他」→ notionExclude = 1

STEP 4: カテゴリ②が「導入事例」の場合、導入先企業の規模を確認
  - 上場企業 or 業界大手 → notionExclude = 0
  - 中小企業・スタートアップ → notionExclude = 1

STEP 5: カテゴリ②が「パートナーシップ」の場合、契約種別を確認
  - 戦略提携・共同開発 → notionExclude = 0
  - 販売代理店・取次契約 → notionExclude = 1

STEP 6: カテゴリ②が「受賞・採択」の場合、媒体の権威性を確認
  - 主要経済紙（週刊東洋経済、日経ビジネス、Forbes等）のメディア選出 → notionExclude = 0
  - それ以外の受賞・採択 → 内容に応じて判断

STEP 7: カテゴリ②が「出版・発信」でセミナー告知の内容 → notionExclude = 1

上記いずれにも該当しない場合 → notionExclude = 0

## 出力形式
JSON形式のみで返答してください。説明文は不要です。

{
  "cat1": "資金調達|事業進捗|その他",
  "cat2": "プロダクト|パートナーシップ|導入事例|特集|受賞・採択|出版・発信|組織・人事|",
  "notionExclude": 0,
  "reason": "判断理由を日本語で一文"
}`;

const VALID_CAT1 = ['資金調達', '事業進捗', 'その他'];

/**
 * 1件の記事を分類する
 * 失敗時はデフォルト値を返す（処理を継続するため）
 */
async function classifyItem(item) {
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: buildPrompt(item.title, item.company, item.url || ''),
        },
      ],
    });

    const text = message.content[0].text.trim();

    // JSON 部分を抽出（コードブロック等に囲まれている場合も対応）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('レスポンスに JSON が見つかりません');

    const json = JSON.parse(jsonMatch[0]);

    const cat1 = VALID_CAT1.includes(json.cat1) ? json.cat1 : 'その他';
    const cat2 = typeof json.cat2 === 'string' ? json.cat2.trim() : '';
    const notionExclude = json.notionExclude === 1 ? '1' : '';

    return { cat1, cat2, notionExclude };
  } catch (e) {
    console.warn(`  [WARN] 分類失敗 "${item.title.slice(0, 40)}...": ${e.message}`);
    return { cat1: 'その他', cat2: '', notionExclude: '' };
  }
}

/**
 * 同一タイトルの重複記事を検出し、2件目以降に notionExclude = "1" を設定
 */
function markDuplicates(cache) {
  let dupCount = 0;
  const seenTitles = new Set();
  // 月を時系列順（昇順）に処理
  for (const month of Object.keys(cache).sort()) {
    for (const item of cache[month]) {
      const key = item.title.trim();
      if (seenTitles.has(key)) {
        if (item.notionExclude !== '1') {
          item.notionExclude = '1';
          dupCount++;
          console.log(`[INFO] 重複検出（除外）: ${item.company} - ${key.slice(0, 50)}...`);
        }
      } else {
        seenTitles.add(key);
      }
    }
  }
  return dupCount;
}

async function main() {
  const cachePath = path.join(process.cwd(), 'data', 'news-cache.json');

  if (!fs.existsSync(cachePath)) {
    console.log('[INFO] news-cache.json が存在しません。スキップします。');
    return;
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  let classifiedCount = 0;
  let skippedCount = 0;

  for (const month of Object.keys(cache).sort()) {
    for (const item of cache[month]) {
      // カテゴリ①が既に入力済みかつnotionExcludeも設定済みならスキップ
      if (item.cat1 && item.notionExclude !== undefined) {
        skippedCount++;
        continue;
      }

      console.log(`[INFO] 分類中 [${month}] ${item.company}: ${item.title.slice(0, 50)}...`);
      const result = await classifyItem(item);

      if (!item.cat1) {
        item.cat1 = result.cat1;
        item.cat2 = result.cat2;
      }
      if (item.notionExclude === undefined) {
        item.notionExclude = result.notionExclude;
      }
      classifiedCount++;

      // API レート制限を考慮して少し待つ
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 重複記事の検出・除外
  const dupCount = markDuplicates(cache);

  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  console.log(`[INFO] 分類完了: ${classifiedCount} 件を分類、${skippedCount} 件はスキップ（入力済み）`);
  if (dupCount > 0) {
    console.log(`[INFO] 重複除外: ${dupCount} 件`);
  }
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
