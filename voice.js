// ============ ملف الصوت: تحويل نص لصوت (TTS) وتفريغ صوت لنص (STT) ============
// كل شغل الصوت بتاع لونا موجود هون، منفصل عن index.js عشان التنظيم
//
// TTS بقى يستخدم Groq API الرسمي (موديل Orpheus Arabic Saudi) بدل msedge-tts
// السبب: msedge-tts بيعتمد على واجهة مايكروسوفت الغير رسمية (Edge Read Aloud)
// وهاي ممكن تنقطع أو تتغير من غير سابق إنذار، لأنها مش API مدعوم رسمياً.
// Groq TTS رسمي وبتوكن (نفس GROQ_API_KEY المستخدم أصلاً بالتفريغ !صوت)

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { execFile } = require('child_process');

// ============ إعدادات صوت لونا (Groq - Orpheus Arabic Saudi) ============
const TTS_MODEL = 'canopylabs/orpheus-arabic-saudi';
const LUNA_VOICE = 'noura'; // صوت بنت سعودي طبيعي (لونا)
const TTS_RESPONSE_FORMAT = 'ogg'; // واتساب بياخد Voice Note بصيغة ogg/opus

// الموديل العربي عند Groq بياخد حد أقصى 200 حرف بالطلب الواحد
// فلو النص أطول، منقسمه لأجزاء (بدون ما نقطع بنص كلمة) ومنولد كل جزء لحاله
const MAX_CHARS_PER_REQUEST = 190; // هامش أمان تحت الـ200

function splitTextForTTS(text, maxLen = MAX_CHARS_PER_REQUEST) {
  const words = text.trim().split(/\s+/);
  const chunks = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      // لو الكلمة نفسها أطول من الحد (نادر)، بنقصها إجبارياً
      let remaining = word;
      while (remaining.length > maxLen) {
        chunks.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
      }
      current = remaining;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// بيولّد جزء واحد من النص كصوت (buffer بصيغة ogg) عن طريق Groq API
async function generateSpeechChunk(text, groqApiKey, attempt = 1) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/speech',
      {
        model: TTS_MODEL,
        voice: LUNA_VOICE,
        input: text,
        response_format: TTS_RESPONSE_FORMAT
      },
      {
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 20000
      }
    );
    return Buffer.from(response.data);
  } catch (err) {
    const detail = err.response
      ? `${err.response.status} ${JSON.stringify(err.response.data)}`
      : err.message;
    console.error(`خطأ بتوليد الصوت (محاولة ${attempt}):`, detail);
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500)); // ثانية ونص قبل ما نجرب تاني
      return generateSpeechChunk(text, groqApiKey, attempt + 1);
    }
    throw err;
  }
}

// لو النص انقسم لأكتر من جزء، بنولد كل جزء لحاله وبعدين نلزقهم صوت واحد بـ ffmpeg
// (concat بدون إعادة ترميز، فسريع وما يأثرش على الجودة)
async function concatOggBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];

  const tmpId = crypto.randomBytes(6).toString('hex');
  const partPaths = buffers.map((_, i) => path.join(os.tmpdir(), `luna_${tmpId}_${i}.ogg`));
  const listPath = path.join(os.tmpdir(), `luna_${tmpId}_list.txt`);
  const outPath = path.join(os.tmpdir(), `luna_${tmpId}_out.ogg`);

  try {
    buffers.forEach((buf, i) => fs.writeFileSync(partPaths[i], buf));
    const listContent = partPaths.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');

    await new Promise((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
        (err) => (err ? reject(err) : resolve())
      );
    });

    return fs.readFileSync(outPath);
  } finally {
    [...partPaths, listPath, outPath].forEach((p) => {
      try { fs.unlinkSync(p); } catch (_) {}
    });
  }
}

// ============ الدالة الرئيسية: تحويل نص لصوت (Groq TTS) وتجهيزه كرسالة صوتية واتساب ============
async function textToVoiceBuffer(text, groqApiKey) {
  const chunks = splitTextForTTS(text);
  const buffers = [];
  for (const chunk of chunks) {
    const buf = await generateSpeechChunk(chunk, groqApiKey);
    buffers.push(buf);
  }
  return concatOggBuffers(buffers);
}

// ============ تفريغ رسالة صوتية لنص (Groq Whisper) ============
async function transcribeVoiceBuffer(buffer, mimetype, groqApiKey) {
  const form = new FormData();
  const ext = (mimetype || '').includes('ogg') ? 'ogg' : 'mp3';
  form.append('file', buffer, { filename: `voice.${ext}`, contentType: mimetype || 'audio/ogg' });
  form.append('model', 'whisper-large-v3-turbo');

  const response = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${groqApiKey}`
      },
      maxBodyLength: Infinity
    }
  );
  return (response.data.text || '').trim();
}

module.exports = {
  LUNA_VOICE,
  textToVoiceBuffer,
  transcribeVoiceBuffer
};
