/**
 * 秋田オンライン塾 LINE AI Bot (Google Apps Script)
 *
 * - LINE Messaging API Webhook
 * - Google Sheets ナレッジ検索 + Gemini 2.5 Flash 連携
 * - 信頼度80%で自動応答 / レビュー振り分け
 * - ガードレール（金融・税務・法務・個人情報）
 * - 会話ログをスプレッドシートに保存
 */

// ========================================
// 設定値
// ========================================
const CONFIG = {
  GEMINI_API_KEY: 'AIzaSyAnJgN9w059sSyxn7JZH8mbCBdbVgG8j0o',
  LINE_CHANNEL_ACCESS_TOKEN: 'TKPW62hbJ8twsGl7nLSA1Hrw3K5ZU46X3iGSbTMqdcmQYLU2ejatkIfYAyIisMZaoDZH9AATY3EN+qzWM+xfd/n3QSMDyCeHe+4I05Qq8nELduFR2ytJKHF2G97P+8tKK3iGGhr2PCJIUpYMzscJSgdB04t89/1O/w1cDnyilFU=',
  LINE_CHANNEL_SECRET: 'bfcb4c4fd21f54149b822b49d4d81af1',
  SPREADSHEET_ID: '1_6spvwA1jYqjHTMRPJaLSlB90g-V6ijZOVfHE7zWTJA',
  KNOWLEDGE_SHEET_NAME: 'ナレッジベース',
  LOG_SHEET_NAME: 'ログ',
  GEMINI_MODEL: 'models/gemini-2.5-flash',
  CONFIDENCE_THRESHOLD: {
    AUTO_REPLY: 80,
    NEEDS_REVIEW: 80
  },
  FALLBACK_MESSAGE: '詳細を確認して折り返します。少しお時間をください。'
};

// 認証情報などは Script Properties で上書き可能
function ensureRuntimeConfig() {
  try {
    const props = PropertiesService.getScriptProperties();
    const keys = ['GEMINI_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'SPREADSHEET_ID'];
    keys.forEach(function(key) {
      const value = (props.getProperty(key) || '').trim();
      if (value) {
        CONFIG[key] = value;
      }
    });
  } catch (error) {
    Logger.log('ScriptProperties 読み込みエラー: ' + error);
  }
}

// ========================================
// LINE Webhook 受信
// ========================================
function doPost(e) {
  ensureRuntimeConfig();

  if (!e || !e.postData || !e.postData.contents) {
    return createJsonResponse({ status: 'no_content' });
  }

  const signature = getLineSignature(e);
  if (CONFIG.LINE_CHANNEL_SECRET) {
    if (signature) {
      const valid = verifyLineSignature(e.postData.contents, signature, CONFIG.LINE_CHANNEL_SECRET);
      if (!valid) {
        Logger.log('署名検証に失敗しました');
        return ContentService.createTextOutput('signature error').setMimeType(ContentService.MimeType.TEXT);
      }
    } else {
      Logger.log('署名ヘッダーが見つからなかったため検証をスキップしました');
    }
  }

  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (error) {
    Logger.log('Webhook JSON 解析エラー: ' + error);
    return ContentService.createTextOutput('bad request').setMimeType(ContentService.MimeType.TEXT);
  }

  if (!data.events || !Array.isArray(data.events)) {
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  }

  data.events.forEach(function(event) {
    try {
      handleLineEvent(event);
    } catch (error) {
      Logger.log('イベント処理エラー: ' + error + '\n' + error.stack);
    }
  });

  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

// 署名検証
function getLineSignature(e) {
  if (!e || !e.parameter) {
    return '';
  }
  return e.parameter['X-Line-Signature'] || e.parameter['x-line-signature'] || e.parameter.signature || '';
}

function verifyLineSignature(rawBody, signature, secret) {
  if (!signature) {
    Logger.log('署名ヘッダーが取得できませんでした。');
    return false;
  }
  const mac = Utilities.computeHmacSha256Signature(rawBody, secret);
  const expectSignature = Utilities.base64Encode(mac);
  return signature === expectSignature;
}

// ========================================
// LINEイベント処理
// ========================================
function handleLineEvent(event) {
  if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') {
    return;
  }

  const userId = (event.source && event.source.userId) ? event.source.userId : 'unknown';
  const messageText = (event.message.text || '').trim();
  if (!messageText) {
    return;
  }

  const replyToken = event.replyToken;
  const profile = getLineUserProfile(userId);
  const username = profile ? profile.displayName || 'unknown' : 'unknown';

  const workflowResult = buildResponse(messageText, userId, username);
  if (workflowResult.replyText) {
    replyToLine(replyToken, workflowResult.replyText);
  }

  logConversation({
    userId: userId,
    username: username,
    question: messageText,
    answer: workflowResult.replyText,
    source: workflowResult.source,
    confidence: workflowResult.confidence,
    needsReview: workflowResult.needsReview,
    draftResponse: workflowResult.draftResponse
  });
}

// LINE ユーザープロフィール取得（任意）
function getLineUserProfile(userId) {
  if (!userId || userId === 'unknown' || !CONFIG.LINE_CHANNEL_ACCESS_TOKEN) {
    return null;
  }
  try {
    const url = 'https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId);
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN
      },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
      return JSON.parse(response.getContentText());
    }
  } catch (error) {
    Logger.log('プロフィール取得エラー: ' + error);
  }
  return null;
}

// ========================================
// 応答生成フロー
// ========================================
function buildResponse(userMessage, userId, username) {
  let finalText = CONFIG.FALLBACK_MESSAGE;
  let source = 'unknown';
  let confidence = 0;
  let needsReview = true;
  let draftResponse = null;

  const knowledgeResult = searchKnowledgeBase(userMessage);
  if (knowledgeResult && knowledgeResult.confidence >= 0.8) {
    finalText = knowledgeResult.answer;
    source = 'knowledge:' + knowledgeResult.source;
    confidence = Math.round(knowledgeResult.confidence * 100);
    needsReview = false;
    return { replyText: finalText, source: source, confidence: confidence, needsReview: needsReview, draftResponse: null };
  }

  const geminiResponse = generateGeminiResponse(userMessage, knowledgeResult ? knowledgeResult.context : null, username);

  if (!geminiResponse) {
    return {
      replyText: CONFIG.FALLBACK_MESSAGE,
      source: 'error',
      confidence: 0,
      needsReview: true,
      draftResponse: null
    };
  }

  const guardrail = checkGuardrails(geminiResponse, userMessage);
  if (!guardrail.passed) {
    draftResponse = geminiResponse;
    return {
      replyText: CONFIG.FALLBACK_MESSAGE,
      source: 'guardrail:' + guardrail.reason,
      confidence: 0,
      needsReview: true,
      draftResponse: draftResponse
    };
  }

  confidence = Math.round(evaluateAIConfidence(userMessage, geminiResponse, knowledgeResult) * 100);
  if (confidence >= CONFIG.CONFIDENCE_THRESHOLD.AUTO_REPLY) {
    finalText = geminiResponse;
    source = 'gemini:auto';
    needsReview = false;
  } else {
    draftResponse = geminiResponse;
    finalText = CONFIG.FALLBACK_MESSAGE;
    source = 'gemini:review';
    needsReview = true;
  }

  return {
    replyText: finalText,
    source: source,
    confidence: confidence,
    needsReview: needsReview,
    draftResponse: draftResponse
  };
}

// ========================================
// ナレッジ検索
// ========================================
function searchKnowledgeBase(query) {
  if (!CONFIG.SPREADSHEET_ID) {
    return null;
  }
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    let sheet = spreadsheet.getSheetByName(CONFIG.KNOWLEDGE_SHEET_NAME);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(CONFIG.KNOWLEDGE_SHEET_NAME);
      sheet.appendRow(['key', 'title', 'content']);
      return null;
    }

    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      return null;
    }

    const header = data.shift();
    const queryTokens = tokenizeText(query);
    if (queryTokens.length === 0) {
      return null;
    }

    let best = null;
    data.forEach(function(row) {
      const record = mapRowToKnowledge(row, header);
      if (!record.content) {
        return;
      }
      const combined = (record.title + ' ' + record.content).trim();
      const score = calculateSimilarityScore(queryTokens, combined);
      if (!best || score > best.confidence) {
        best = {
          answer: record.content,
          source: record.key || record.title || 'untitled',
          confidence: score,
          context: combined
        };
      }
    });
    return best;

  } catch (error) {
    Logger.log('ナレッジ検索エラー: ' + error);
    return null;
  }
}

function mapRowToKnowledge(row, header) {
  const record = {};
  for (let i = 0; i < header.length; i++) {
    const key = header[i];
    record[key] = row[i];
  }
  return {
    key: record.key || '',
    title: record.title || '',
    content: record.content || ''
  };
}

function tokenizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[\n\r]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(function(token) { return token.length > 1; });
}

function calculateSimilarityScore(queryTokens, documentText) {
  const docTokens = tokenizeText(documentText);
  if (docTokens.length === 0) {
    return 0;
  }
  const docSet = {};
  docTokens.forEach(function(token) { docSet[token] = true; });
  let intersection = 0;
  queryTokens.forEach(function(token) {
    if (docSet[token]) {
      intersection++;
    }
  });
  const union = new Set(queryTokens.concat(docTokens)).size;
  let score = union > 0 ? intersection / union : 0;
  const plainDoc = documentText.toLowerCase();
  const plainQuery = queryTokens.join(' ');
  if (plainDoc.indexOf(plainQuery) !== -1) {
    score += 0.2;
  }
  return Math.min(score, 1);
}

// ========================================
// Gemini 連携
// ========================================
function generateGeminiResponse(userMessage, knowledgeContext, username) {
  if (!CONFIG.GEMINI_API_KEY) {
    Logger.log('Gemini APIキー未設定');
    return null;
  }
  const systemPrompt = 'あなたは秋田のオンライン塾のスタッフです。保護者や生徒に丁寧で親しみのある日本語の回答を提供してください。金融・法務・税務の助言や個人情報の取得は避け、安心できる案内に徹してください。';
  const contextPrompt = knowledgeContext ? '参考情報:\n' + knowledgeContext : '';

  const url = 'https://generativelanguage.googleapis.com/v1beta/' + CONFIG.GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(CONFIG.GEMINI_API_KEY);
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: systemPrompt + '\n' + contextPrompt + '\n質問者: ' + (username || '保護者') + '\n質問内容: ' + userMessage }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 800
    }
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      Logger.log('Gemini APIエラー: ' + response.getContentText());
      return null;
    }

    const json = JSON.parse(response.getContentText());
    if (json && json.candidates && json.candidates.length > 0) {
      const parts = json.candidates[0].content.parts;
      if (parts && parts.length > 0 && parts[0].text) {
        return parts[0].text.trim();
      }
    }
    return null;
  } catch (error) {
    Logger.log('Gemini 呼び出しエラー: ' + error);
    return null;
  }
}

// ========================================
// ガードレール
// ========================================
const GUARDRAILS = {
  // 禁忌: ボットが回答してはいけないテーマのキーワード
  forbiddenKeywords: [
    // 金融・投資
    '株を', '銘柄', '確実に儲かる', '絶対に上がる', '絶対に下がる', '投資を勧め',
    // 税務・法務
    '税額', '確定申告', '法的には', '違法',
    // 個人情報・セキュリティ
    'クレジットカード', 'カード番号', '口座番号', '暗証番号', 'パスワード', 'マイナンバー',
    '住所を教えて', '電話番号教えて', '個人情報を教えて', '講師の住所', '講師の電話番号',
    // 合格保証や裏ワザ要求
    '合格保証', '必ず合格', '裏ルート', '試験の答え', '答案を教えて',
    // 医療・診断
    '診断して', '病気を診て', '医療的な助言', '薬を教えて'
  ],
  safeResponse: 'その内容についてはチャットではお答えできません。担当スタッフから改めてご連絡いたしますのでお待ちください。'
};

function checkGuardrails(response, originalQuestion) {
  const text = ((response || '') + ' ' + (originalQuestion || '')).toLowerCase();
  for (let i = 0; i < GUARDRAILS.forbiddenKeywords.length; i++) {
    const keyword = GUARDRAILS.forbiddenKeywords[i].toLowerCase();
    if (text.indexOf(keyword) !== -1) {
      return { passed: false, reason: keyword };
    }
  }
  return { passed: true, reason: null };
}

// ========================================
// 信頼度評価
// ========================================
function evaluateAIConfidence(question, answer, knowledgeResult) {
  if (!answer) {
    return 0;
  }

  if (answer.trim() === CONFIG.FALLBACK_MESSAGE.trim()) {
    return 0;
  }

  let score = 0.9;
  const normalizedAnswer = answer.toLowerCase();

  if (knowledgeResult && knowledgeResult.confidence) {
    const templateBoost = Math.min(knowledgeResult.confidence + 0.4, 1);
    score = Math.max(score, templateBoost);
  }

  const length = answer.length;
  if (length < 60) {
    score -= 0.35;
  } else if (length < 140) {
    score -= 0.10;
  } else if (length > 600) {
    score += 0.05;
  }

  const negativePhrases = ['できません', 'わかりませ', '対応できません', '確認いたします', '調整いたします'];
  if (negativePhrases.some(function(phrase) { return normalizedAnswer.indexOf(phrase) !== -1; })) {
    score -= 0.25;
  }

  const apologyPhrases = ['申し訳', 'お詫び'];
  if (apologyPhrases.some(function(phrase) { return normalizedAnswer.indexOf(phrase) !== -1; })) {
    score -= 0.10;
  }

  if (question) {
    const snippet = question.toLowerCase().slice(0, 15);
    if (snippet && snippet.length >= 3 && normalizedAnswer.indexOf(snippet) !== -1) {
      score += 0.05;
    }
  }

  return Math.max(0, Math.min(1, score));
}

// ========================================
// LINE返信
// ========================================
function replyToLine(replyToken, text) {
  if (!replyToken || !CONFIG.LINE_CHANNEL_ACCESS_TOKEN) {
    return;
  }

  const url = 'https://api.line.me/v2/bot/message/reply';
  const body = {
    replyToken: replyToken,
    messages: [
      {
        type: 'text',
        text: text
      }
    ]
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      headers: {
        Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN
      },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() >= 300) {
      Logger.log('LINE返信エラー: ' + response.getContentText());
    }
  } catch (error) {
    Logger.log('LINE返信失敗: ' + error);
  }
}

// ========================================
// ログ保存
// ========================================
function logConversation(entry) {
  if (!CONFIG.SPREADSHEET_ID) {
    return;
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    let sheet = spreadsheet.getSheetByName(CONFIG.LOG_SHEET_NAME);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(CONFIG.LOG_SHEET_NAME);
      sheet.appendRow(['timestamp', 'userId', 'username', 'question', 'answer', 'source', 'confidence', 'needsReview', 'draft']);
    }

    sheet.appendRow([
      new Date(),
      entry.userId,
      entry.username,
      entry.question,
      entry.answer,
      entry.source,
      entry.confidence,
      entry.needsReview,
      entry.draftResponse || ''
    ]);
  } catch (error) {
    Logger.log('ログ記録エラー: ' + error);
  }
}

// ========================================
// 共通
// ========================================
function createJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput('ok');
}

