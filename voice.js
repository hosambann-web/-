// ============ ملف الصوت: تحويل نص لصوت (TTS) وتفريغ صوت لنص (STT) ============
// كل شغل الصوت بتاع لونا موجود هون، منفصل عن index.js عشان التنظيم

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { execFile } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// ============ تحويل النص لصوت (Edge TTS) وتجهيزه كرسالة صوتية واتساب ============
// الخطوات: نولد الصوت بصيغة webm/opus من Edge، وبعدين نحوله لـ ogg/opus (اللي واتساب يقبله كـ Voice Note)
// التحويل بس "إعادة تغليف" (remux) بدون إعادة ترميز، فسريع وما يأثرش على الجودة
// ملاحظة: لازم ffmpeg يكون مثبت على السيرفر (ضيفه بالـ Dockerfile: apt-get install -y ffmpeg)
const LUNA_VOICE = 'ar-EG-SalmaNeural'; // صوت بنت عربي طبيعي (لونا)

// بيحاول مرتين قبل ما يستسلم - غالبية فشل TTS بيكون اتصال مؤقت بسيرفر Edge، مش مشكلة دائمة
async function textToVoiceBuffer(text, attempt = 1) {
  const tmpId = crypto.randomBytes(6).toString('hex');
  const webmPath = path.join(os.tmpdir(), `luna_${tmpId}.webm`);
  const oggPath = path.join(os.tmpdir(), `luna_${tmpId}.ogg`);

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(LUNA_VOICE, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    await tts.toFile(webmPath.replace('.webm', ''), text); // المكتبة تضيف .webm تلقائي

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', webmPath, '-c:a', 'copy', oggPath], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const buffer = fs.readFileSync(oggPath);
    return buffer;
  } catch (err) {
    console.error(`خطأ بتوليد الصوت (محاولة ${attempt}):`, err.message);
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500)); // ثانية ونص قبل ما نجرب تاني
      return textToVoiceBuffer(text, attempt + 1);
    }
    throw err;
  } finally {
    // تنظيف الملفات المؤقتة
    [webmPath, oggPath].forEach((p) => {
      try { fs.unlinkSync(p); } catch (_) {}
    });
  }
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
