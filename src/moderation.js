import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

export const rejectionReasons = {
  1: '誹謗中傷、個人攻撃、差別的表現に該当する可能性がある',
  2: '個人情報、住所、電話番号、メールアドレス、アカウント晒しに該当する可能性がある',
  3: '違法行為、犯罪予告、自傷他害の助長に該当する可能性がある',
  4: 'スパム、宣伝、意味不明な連投に該当する可能性がある',
  5: '性的・過度に暴力的・公序良俗に反する内容に該当する可能性がある',
  6: '共有アカウントで投稿すべきでない内容に該当する可能性がある',
  7: '140字を超えている'
};

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

export function countXCharacters(text) {
  return Array.from(text).length;
}

export function buildModerationPrompt(text) {
  return `あなたは共有Xアカウントの投稿前審査システムです。
次の投稿文が運用ルールに違反しているか判定してください。

必ず半角数字1つだけを返してください。
説明文、記号、改行、JSONは返してはいけません。

判定コード:
0 = 問題なし
1 = 誹謗中傷、個人攻撃、差別的表現
2 = 個人情報、住所、電話番号、メールアドレス、アカウント晒し
3 = 違法行為、犯罪予告、自傷他害の助長
4 = スパム、宣伝、意味不明な連投
5 = 性的・過度に暴力的・公序良俗に反する内容
6 = その他、共有アカウントで投稿すべきでない内容
7 = 140字を超えている

投稿文:
「${text}」`;
}

export async function moderatePost(text) {
  if (countXCharacters(text) > 140) {
    return 7;
  }

  const response = await ai.models.generateContent({
    model: config.geminiModel,
    contents: buildModerationPrompt(text),
    config: {
      temperature: 0,
      maxOutputTokens: 4
    }
  });

  const raw = String(response.text || '').trim();
  const match = raw.match(/^\d+$/);
  if (!match) {
    return 6;
  }

  const code = Number(raw);
  if (!Number.isInteger(code) || code < 0) {
    return 6;
  }
  return code;
}
