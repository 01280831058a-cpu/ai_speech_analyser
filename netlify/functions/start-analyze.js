import { Buffer } from 'node:buffer';
import Busboy from 'busboy';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

// Переменные окружения Netlify:
// YANDEX_API_KEY, YANDEX_FOLDER_ID (SpeechKit & GPT)
// YC_ACCESS_KEY_ID, YC_SECRET_ACCESS_KEY, YC_BUCKET_NAME

const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const BUCKET_NAME = process.env.YC_BUCKET_NAME;
const S3_ENDPOINT = 'https://storage.yandexcloud.net';

const s3 = new S3Client({
  region: 'ru-central1',
  endpoint: S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY_ID,
    secretAccessKey: process.env.YC_SECRET_ACCESS_KEY,
  },
});

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const { task, audioBuffer, originalName } = await parseMultipart(event);
    if (!task || !audioBuffer) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing task or audio' }) };
    }

    // 1. Загружаем аудио в Yandex Object Storage (публичный доступ на чтение)
    const fileExt = originalName.split('.').pop().toLowerCase();
    const key = `speech_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${fileExt}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: audioBuffer,
      ContentType: `audio/${fileExt === 'm4a' ? 'm4a' : (fileExt === 'mp3' ? 'mpeg' : 'wav')}`,
      ACL: 'public-read',   // временно публичный для доступа SpeechKit
    }));

    const fileUrl = `https://${BUCKET_NAME}.storage.yandexcloud.net/${key}`;

    // 2. Запускаем асинхронное распознавание SpeechKit
    const operationId = await startAsyncRecognition(fileUrl, fileExt);

    // Сохраняем task где-то, чтобы потом использовать. Можно в глобальную переменную, но у Netlify функций нет памяти. Поэтому передадим task через клиент при опросе статуса (как параметр). Или используем временное хранилище (Redis, Upstash). Для простоты клиент будет передавать task в check-status.
    // В check-status мы получим task из query параметра.

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ operationId })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
}

async function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: { 'content-type': event.headers['content-type'] } });
    let task = '';
    let audioBuffer = null;
    let originalName = '';
    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'task') task = val;
    });
    busboy.on('file', (fieldname, file, info) => {
      if (fieldname === 'audio') {
        originalName = info.filename;
        const chunks = [];
        file.on('data', (chunk) => chunks.push(chunk));
        file.on('end', () => audioBuffer = Buffer.concat(chunks));
      } else file.resume();
    });
    busboy.on('finish', () => {
      if (!task || !audioBuffer) reject(new Error('Missing fields'));
      else resolve({ task, audioBuffer, originalName });
    });
    busboy.on('error', reject);
    busboy.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    busboy.end();
  });
}

async function startAsyncRecognition(fileUrl, fileExt) {
  const url = `https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize`;
  const body = {
    config: {
      specification: {
        languageCode: 'ru-RU',
        model: 'general',
        audioEncoding: fileExt === 'm4a' ? 'M4A' : (fileExt === 'mp3' ? 'MP3' : 'LINEAR16_PCM'),
      },
    },
    audio: { uri: fileUrl }
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Api-Key ${YANDEX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Async recognize start error: ${err}`);
  }
  const data = await resp.json();
  return data.id; // operationId
}
