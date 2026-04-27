import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const BUCKET_NAME = process.env.YC_BUCKET_NAME;
const s3 = new S3Client({
  region: 'ru-central1',
  endpoint: 'https://storage.yandexcloud.net',
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY_ID,
    secretAccessKey: process.env.YC_SECRET_ACCESS_KEY,
  },
});

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  const operationId = event.queryStringParameters?.operationId;
  const task = event.queryStringParameters?.task;
  if (!operationId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing operationId' }) };
  }

  try {
    // 1. Проверяем статус асинхронного распознавания
    const statusResp = await fetch(`https://operation.api.cloud.yandex.net/operations/${operationId}`, {
      headers: { 'Authorization': `Api-Key ${YANDEX_API_KEY}` }
    });
    const opData = await statusResp.json();
    if (opData.done !== true) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'processing' }) };
    }
    if (opData.error) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: opData.error.message }) };
    }

    // 2. Извлекаем распознанный текст
    const recognizedText = opData.response?.chunks?.map(chunk => chunk.alternatives[0]?.text).join(' ') || '';
    if (!recognizedText) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: 'Пустой текст распознавания' }) };
    }

    // 3. Анализ через YandexGPT
    const feedback = await analyzeWithGPT(task, recognizedText);

    // 4. (опционально) Удаляем файл из бакета, чтобы не накапливать
    // Для удаления нужно знать ключ объекта. Мы не храним ключ в функции. Лучше удалить через отдельную очистку позже, или передавать ключ из start-analyze.
    // Но для простоты пропустим или попробуем извлечь имя из operationData? В ответе операции нет ссылки на объект. Оставим как есть — файлы будут удаляться автоматически по политике бакета или вручную.

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'completed', feedback, recognizedText })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ status: 'failed', error: err.message })
    };
  }
}

async function analyzeWithGPT(task, userSpeech) {
  const prompt = `
Ты — эксперт CEFR, уровень B2-C1.
Задание: """${task}"""
Речь пользователя (расшифровка): """${userSpeech}"""

Оцени по шкале 1-5:
- Соответствие заданию и аргументация
- Лексика (слова, идиомы)
- Грамматическая сложность/точность
- Беглость и связность
- Произношение (приблизительно по тексту)

Итоговый уровень (B2, B2+, C1). Напиши разбор, сильные/слабые стороны, 2 совета.
Формат: дружелюбный, с эмодзи, абзацами.
  `;
  const url = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
  const body = {
    modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt-lite`,
    completionOptions: { stream: false, temperature: 0.4, maxTokens: 1200 },
    messages: [
      { role: 'system', text: 'Ты строгий экзаменатор английского B2-C1.' },
      { role: 'user', text: prompt }
    ]
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Api-Key ${YANDEX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`GPT error ${resp.status}`);
  const data = await resp.json();
  return data.result?.alternatives?.[0]?.message?.text || 'Ошибка генерации анализа.';
}
