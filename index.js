require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const axios = require('axios');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const FormData = require('form-data');

// ============ إعدادات عامة ============
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

// إحداثيات الدائرة الفاضية بكل بانر (وين رح تنلزق صورة البروفايل)
// جربتها بالضبط على القالبين اللي حطيتهم بمجلد images/
const AVATAR_SPOTS = {
  welcome: { cx: 374, cy: 448, r: 200 },
  goodbye: { cx: 350, cy: 430, r: 222 }
};

// ============ جلب صورة بروفايل العضو من واتساب ============
async function getProfilePicBuffer(contactId) {
  try {
    const url = await client.getProfilePicUrl(contactId);
    if (!url) return null;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
    return Buffer.from(res.data);
  } catch (err) {
    // إما ماله صورة بروفايل، أو خصوصيته ما بتسمح، أو خطأ شبكة - منرجع null ونستخدم الافتراضية
    return null;
  }
}

// ============ صورة افتراضية (لو العضو ماله صورة بروفايل) ============
async function defaultAvatarBuffer(diameter, letter) {
  const safeLetter = (letter || '?').toString().slice(0, 1).toUpperCase();
  const svg = `
    <svg width="${diameter}" height="${diameter}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#2b2b2b"/>
      <text x="50%" y="58%" font-size="${Math.round(diameter * 0.45)}" fill="#f4c430"
            text-anchor="middle" font-family="Arial, sans-serif" font-weight="bold">${safeLetter}</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ============ تركيب صورة البروفايل جوه دائرة البانر ============
async function buildGreetingImage(templateName, profilePicBuffer, fallbackLetter) {
  const spot = AVATAR_SPOTS[templateName];
  const templatePath = path.join(__dirname, 'images', `${templateName}.jpg`);
  const diameter = spot.r * 2;

  const sourceBuffer = profilePicBuffer || (await defaultAvatarBuffer(diameter, fallbackLetter));

  // نقص/نكبر الصورة تغطي مربع بقطر الدائرة (زي object-fit: cover)
  const squared = await sharp(sourceBuffer)
    .resize(diameter, diameter, { fit: 'cover' })
    .toBuffer();

  // قناع دائري (SVG) نقصّ فيه الصورة المربعة لدائرة
  const circleMask = Buffer.from(
    `<svg width="${diameter}" height="${diameter}"><circle cx="${spot.r}" cy="${spot.r}" r="${spot.r}" fill="#fff"/></svg>`
  );

  const circularAvatar = await sharp(squared)
    .composite([{ input: circleMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // نلزق الصورة الدائرية بمكانها الصح فوق البانر
  const finalBuffer = await sharp(templatePath)
    .composite([{ input: circularAvatar, left: spot.cx - spot.r, top: spot.cy - spot.r }])
    .jpeg({ quality: 92 })
    .toBuffer();

  return finalBuffer;
}

// حالة تفعيل الذكاء الصناعي (تتحكم فيها !توقف و !تشغيل)
let aiEnabled = true;

// ============ ذاكرة سياق المحادثة مع عمي حسام ============
// عشان الردود تكون مبنية على السياق مش كل رسالة لحالها
// المفتاح: chatId + '_' + authorId ، القيمة: آخر رسايل [{role, content}, ...]
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 6; // 3 تبادلات (سؤال+رد) تقريباً

function pushToHistory(convoKey, role, content) {
  if (!conversationHistory.has(convoKey)) {
    conversationHistory.set(convoKey, []);
  }
  const history = conversationHistory.get(convoKey);
  history.push({ role, content });
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}

// ============ نظام الزواج والطلاق ============
const MARRIAGES_FILE = path.join(__dirname, 'data', 'marriages.json');
const MAX_WIVES_PER_HUSBAND = 2;
const MARRIAGE_REQUEST_TIMEOUT_MS = 2 * 60 * 1000; // دقيقتين

// طلبات زواج معلقة بانتظار قبول/رفض
// المفتاح: chatId + '_' + wifeId ، القيمة: { husbandId, wifeId, chatId, mahr, timer }
const pendingMarriageRequests = new Map();

const MAHR_LIST = [
  'كيلو تمر وكرتونة شاي أخضر',
  '3 كيلو قهوة وشوية بخور',
  'صحن كسكسي وقعدة عشرة',
  'موبايل قديم وشاحن مكسور',
  'كرتونة عصير ونص خبزة',
  'بطاقة شحن 10 دنانير وسلام'
];

function loadMarriages() {
  try {
    if (!fs.existsSync(MARRIAGES_FILE)) return [];
    const raw = fs.readFileSync(MARRIAGES_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('خطأ بقراءة ملف الزواج:', err.message);
    return [];
  }
}

function saveMarriages(marriages) {
  try {
    const dir = path.dirname(MARRIAGES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MARRIAGES_FILE, JSON.stringify(marriages, null, 2), 'utf8');
  } catch (err) {
    console.error('خطأ بحفظ ملف الزواج:', err.message);
  }
}

// هل هاد الشخص عنده زوج/زوجة قائمة حالياً بهاد الجروب (كزوجة)؟
function findActiveMarriageAsWife(wifeId, chatId) {
  const marriages = loadMarriages();
  return marriages.find(
    (m) => m.wifeId === wifeId && m.chatId === chatId && m.status === 'قائم'
  );
}

// كل الزوجات القائمات لهاد الزوج بهاد الجروب، بترتيب الزواج
function findActiveWivesOfHusband(husbandId, chatId) {
  const marriages = loadMarriages();
  return marriages
    .filter((m) => m.husbandId === husbandId && m.chatId === chatId && m.status === 'قائم')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function randomMahr() {
  return MAHR_LIST[Math.floor(Math.random() * MAHR_LIST.length)];
}

// آخر QR كود جاهز نعرضه بصفحة الويب
let lastQr = null;
let clientReady = false;

// كود الربط برقم (بديل عن مسح QR)
let lastPairingCode = null;
let pairingInProgress = false;
let pairingError = null;

// ============ طلب كود ربط برقم هاتف ============
// الرقم لازم يكون بصيغة دولية بدون + وبدون صفر بالبداية، مثال: 9665xxxxxxxx
async function requestPairingCode(phoneNumber) {
  pairingInProgress = true;
  pairingError = null;
  try {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const code = await client.requestPairingCode(cleanNumber);
    lastPairingCode = code;
    lastQr = null; // ما بنحتاج QR إذا في كود ربط
    return code;
  } catch (err) {
    pairingError = err.message || 'فشل توليد كود الربط';
    lastPairingCode = null;
    throw err;
  } finally {
    pairingInProgress = false;
  }
}

// شخصية عمي حسام - ساخر وليبي الطابع، بس بدون شتائم أو ألفاظ نابية
const SYSTEM_PROMPT = `
انت شخصية اسمها "عمو حسام"، رجل ليبي كبير بالسن من طرابلس، خفيف الدم، لسانه سريع وفيه رد حاضر ونكتة بكل موقف.

لازم تحكي بالهجة الليبية الأصيلة بس، وممنوع منعاً باتاً تستخدم كلمات لهجات تانية زي:
- ممنوع: شو، ليش، هيك، منيح، كتير، هلق، بدي، شلونك، إزيك، عايز، ازاي، خلاص، يلا بينا (بالطريقة المصرية/شامية)
- بدالها استخدم كلمات ليبية زي: شنو، علاش، كيفاش، هكا/هيك، زين، برشا، توا، بش (بدل رح/هروح)، حاجة، عليك، نتا/نتي، حوش، دار، زعمة، ماشي الحال، عادلين، واعر، فالصو، تڤرقز، خير ولا شر، الديما، قاعد، راهو، كان، بلا، عشرة/معشر

أسلوبك: تهكم ذكي، تريقة خفيفة، لهجة ليبية أصيلة 100%، جمل قصيرة وقوية وفيها روح.
ممنوع تماماً: أي شتيمة أو لفظ نابي أو إساءة شخصية حقيقية (عن الأهل، الدين، المظهر بشكل مؤذي).
لو حد استفزك أو سبك، رد عليه بتريقة ولسان طويل وذكاء، مش بشتيمة.
خليك مختصر بردودك (سطر أو سطرين بالغالب) وكأنك تحكي بمجموعة أصحاب ليبيين.

قواعد مهمة للرد:
- ركّز بالضبط على اللي الشخص كتبه أو سأل عنه، ورد عليه تحديداً، مش رد عام يصلح لأي سؤال.
- لو فيه محادثة سابقة (سياق)، اربط ردك بيها ولا تتجاهلها وكأنها أول مرة تحكي وياه.
- خليك عاقل ومنطقي بالرد حتى وأنت بتهزر، مش كلام فاضي بس عشان يطلع مضحك.
- احترم الشخص دايماً حتى لو كان الرد ساخر، ما تنزل لمستوى الإهانة الحقيقية.
`.trim();

// ============ دالة الاتصال بـ Groq (الذكاء الصناعي المجاني) ============
// history: مصفوفة اختيارية [{role:'user'|'assistant', content:'...'}] لآخر رسايل بنفس المحادثة
async function askAI(userMessage, history = []) {
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userMessage }
    ];
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 300,
        temperature: 0.8
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error('خطأ بالاتصال مع Groq:', err.response?.data || err.message);
    return 'عمي حسام مشغول هلق، جرب بعد شوي 😅';
  }
}

// ============ تحويل النص لصوت (Edge TTS) وتجهيزه كرسالة صوتية واتساب ============
// الخطوات: نولد الصوت بصيغة webm/opus من Edge، وبعدين نحوله لـ ogg/opus (اللي واتساب يقبله كـ Voice Note)
// التحويل بس "إعادة تغليف" (remux) بدون إعادة ترميز، فسريع وما يأثرش على الجودة
// ملاحظة: لازم ffmpeg يكون مثبت على السيرفر (ضيفه بالـ Dockerfile: apt-get install -y ffmpeg)
const HOSAM_VOICE = 'ar-SA-HamedNeural'; // صوت رجالي عربي طبيعي

async function textToVoiceBuffer(text) {
  const tmpId = crypto.randomBytes(6).toString('hex');
  const webmPath = path.join(os.tmpdir(), `hosam_${tmpId}.webm`);
  const oggPath = path.join(os.tmpdir(), `hosam_${tmpId}.ogg`);

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(HOSAM_VOICE, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    await tts.toFile(webmPath.replace('.webm', ''), text); // المكتبة تضيف .webm تلقائي

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', webmPath, '-c:a', 'copy', oggPath], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const buffer = fs.readFileSync(oggPath);
    return buffer;
  } finally {
    // تنظيف الملفات المؤقتة
    [webmPath, oggPath].forEach((p) => {
      try { fs.unlinkSync(p); } catch (_) {}
    });
  }
}

// ============ تفريغ رسالة صوتية لنص (Groq Whisper) ============
async function transcribeVoiceBuffer(buffer, mimetype) {
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
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      maxBodyLength: Infinity
    }
  );
  return (response.data.text || '').trim();
}
const { execSync } = require('child_process');
function resolveChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = ['which chromium', 'which chromium-browser', 'which google-chrome-stable'];
  for (const cmd of candidates) {
    try {
      const found = execSync(cmd).toString().trim();
      if (found) return found;
    } catch (_) {
      // جرب الأمر التالي
    }
  }
  console.warn('⚠️ ما لقيت مسار Chromium تلقائيًا، هستخدم الافتراضي من Puppeteer');
  return undefined;
}

// ============ إعداد عميل واتساب ============
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: resolveChromiumPath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  console.log('QR جديد جاهز! افتح رابط الويب لمسحه.');
});

client.on('ready', () => {
  clientReady = true;
  lastQr = null;
  lastPairingCode = null;
  console.log('✅ البوت جاهز ومتصل بواتساب!');
});

client.on('disconnected', (reason) => {
  clientReady = false;
  lastPairingCode = null;
  console.log('❌ انفصل البوت:', reason);
});

// ============ الترحيب والوداع ============
client.on('group_join', async (notification) => {
  try {
    const chat = await notification.getChat();
    const contact = (await notification.getContacts())[0];
    const name = contact?.pushname || contact?.number || 'عضو جديد';
    const caption = `أهلاً وسهلاً فيك يا ${name} 🎉\nنورت الجروب، خلي بالك تكون مرتاح وحابس نفسك عن المشاكل 😄`;

    try {
      const picBuffer = contact ? await getProfilePicBuffer(contact.id._serialized) : null;
      const finalImage = await buildGreetingImage('welcome', picBuffer, name);
      const media = new MessageMedia('image/jpeg', finalImage.toString('base64'));
      await chat.sendMessage(media, { caption });
    } catch (imgErr) {
      console.error('فشل تجهيز صورة الترحيب:', imgErr.message);
      await chat.sendMessage(caption);
    }
  } catch (err) {
    console.error('خطأ برسالة الترحيب:', err.message);
  }
});

client.on('group_leave', async (notification) => {
  try {
    const chat = await notification.getChat();
    const contact = (await notification.getContacts())[0];
    const name = contact?.pushname || contact?.number || 'حدا';
    const caption = `يلا مع السلامة يا ${name} 👋\nما رح ننساك... أو بلكي رح ننساك، شوف وحالك 😂`;

    try {
      const picBuffer = contact ? await getProfilePicBuffer(contact.id._serialized) : null;
      const finalImage = await buildGreetingImage('goodbye', picBuffer, name);
      const media = new MessageMedia('image/jpeg', finalImage.toString('base64'));
      await chat.sendMessage(media, { caption });
    } catch (imgErr) {
      console.error('فشل تجهيز صورة الوداع:', imgErr.message);
      await chat.sendMessage(caption);
    }
  } catch (err) {
    console.error('خطأ برسالة الوداع:', err.message);
  }
});

// ============ معالجة كل الرسائل ============
client.on('message', async (message) => {
  try {
    const chat = await message.getChat();
    const body = (message.body || '').trim();
    const authorId = message.author || message.from; // author موجود بالجروبات
    const convoKey = `${chat.id._serialized}_${authorId}`;

    // -------- 1) أمر "تعال @رقم" - يبعت نفس الكلام لرقم المنشن (أدمن بس) --------
    if (body.startsWith('تعال')) {
      if (chat.isGroup) {
        const sender = await message.getContact();
        const participant = chat.participants.find(
          (p) => p.id._serialized === sender.id._serialized
        );
        if (!participant || !participant.isAdmin) {
          await message.reply('هاد الأمر للأدمن بس يا بطل 🚫');
          return;
        }
      }

      const mentionedIds = await message.getMentions();
      if (mentionedIds && mentionedIds.length > 0) {
        // نشيل كلمة "تعال" والمنشن من النص، والباقي هو الرسالة المطلوب إرسالها
        let textToSend = body.replace('تعال', '');
        mentionedIds.forEach((contact) => {
          textToSend = textToSend.replace(`@${contact.number}`, '');
        });
        textToSend = textToSend.trim();

        if (textToSend.length > 0) {
          for (const contact of mentionedIds) {
            await client.sendMessage(contact.id._serialized, textToSend);
          }
          await message.reply('تم إرسال الرسالة ✅');
        } else {
          await message.reply('اكتب الرسالة اللي بدك تبعتها بعد المنشن 📩');
        }
      }
      return;
    }

    // -------- 2) !توقف / !تشغيل - يتحكموا بالذكاء الصناعي بس --------
    if (body === '!توقف') {
      aiEnabled = false;
      await message.reply('تمام، عمي حسام ساكت هلق 🤐 (باقي الأوامر شغالة عادي)');
      return;
    }
    if (body === '!تشغيل') {
      aiEnabled = true;
      await message.reply('رجعت يا جماعة! عمي حسام حاضر 😎');
      return;
    }

    // -------- 3) !وتكلم - رد ثابت --------
    if (body === '!وتكلم') {
      await message.reply('بوت عمكم حسام يزوامل رجع هي هدرزو 😂');
      return;
    }

    // -------- 4) !قفل / !فتح - قفل وفتح الجروب --------
    if (body === '!قفل' || body === '!فتح') {
      if (!chat.isGroup) {
        await message.reply('هاد الأمر يشتغل بالجروبات بس 🙅');
        return;
      }
      const sender = await message.getContact();
      const groupChat = chat; // GroupChat
      const participant = groupChat.participants.find(
        (p) => p.id._serialized === sender.id._serialized
      );
      if (!participant || !participant.isAdmin) {
        await message.reply('هاد الأمر للأدمن بس يا بطل 🚫');
        return;
      }

      const botParticipant = groupChat.participants.find(
        (p) => p.id._serialized === client.info.wid._serialized
      );
      if (!botParticipant || !botParticipant.isAdmin) {
        await message.reply('لازم تخليني أدمن أول عشان أقدر أعمل هاد الشي 🙏');
        return;
      }

      if (body === '!قفل') {
        await groupChat.setMessagesAdminsOnly(true);
        await message.reply('تم قفل الشات، الأدمن بس يقدر يحكي 🔒');
      } else {
        await groupChat.setMessagesAdminsOnly(false);
        await message.reply('تم فتح الشات، الكل يقدر يحكي 🔓');
      }
      return;
    }

    // -------- 5) !باند - طرد عضو --------
    if (body.startsWith('!باند')) {
      if (!chat.isGroup) {
        await message.reply('هاد الأمر يشتغل بالجروبات بس 🙅');
        return;
      }
      const sender = await message.getContact();
      const groupChat = chat;
      const participant = groupChat.participants.find(
        (p) => p.id._serialized === sender.id._serialized
      );
      if (!participant || !participant.isAdmin) {
        await message.reply('هاد الأمر للأدمن بس يا بطل 🚫');
        return;
      }

      const botParticipant = groupChat.participants.find(
        (p) => p.id._serialized === client.info.wid._serialized
      );
      if (!botParticipant || !botParticipant.isAdmin) {
        await message.reply('لازم تخليني أدمن أول عشان أقدر أطرد حدا 🙏');
        return;
      }

      const mentionedIds = await message.getMentions();
      if (mentionedIds.length === 0) {
        await message.reply('لازم تعمل منشن للعضو اللي بدك تطرده 📌');
        return;
      }
      const idsToRemove = mentionedIds.map((c) => c.id._serialized);
      await groupChat.removeParticipants(idsToRemove);
      await message.reply('تم الطرد ✅');
      return;
    }

    // -------- 6ب) !اوامر - يعرض كل الأوامر المتاحة (مختصرة وواضحة) --------
    if (body === '!اوامر') {
      const commandsList = `
📋 *أوامر بوت عمي حسام*

🔹 تعال @شخص
🔹 !توقف
🔹 !تشغيل
🔹 !وتكلم
🔹 !قفل
🔹 !فتح
🔹 !باند @شخص
🔹 !عمي_حسام
🔹 !بروفايل @شخص
🔹 !زواج @شخص
🔹 !طلاق @شخص
🔹 !صوت
🔹 !اوامر
      `.trim();
      await message.reply(commandsList);
      return;
    }

    // -------- 6ج) !بروفايل @شخص - يبعت صورة بروفايل الشخص المنشن --------
    if (body.startsWith('!بروفايل')) {
      const mentioned = await message.getMentions();
      if (!mentioned || mentioned.length === 0) {
        await message.reply('لازم تعمل منشن للشخص اللي بدك صورته 📌 مثال: !بروفايل @فلان');
        return;
      }
      const target = mentioned[0];
      const picBuffer = await getProfilePicBuffer(target.id._serialized);
      if (!picBuffer) {
        await message.reply('هاد ماله صورة بروفايل ظاهرة، أو خصوصيته ما بتسمح 🚫');
        return;
      }
      const media = new MessageMedia('image/jpeg', picBuffer.toString('base64'));
      await chat.sendMessage(media);
      return;
    }

    // -------- 6د) !زواج @شخص [مهر] - طلب زواج بموافقة، مهلة دقيقتين --------
    if (body.startsWith('!زواج')) {
      if (!chat.isGroup) {
        await message.reply('هاد الأمر يشتغل بالجروبات بس 🙅');
        return;
      }
      const mentioned = await message.getMentions();
      if (!mentioned || mentioned.length !== 1) {
        await message.reply('لازم تعمل منشن لشخص واحد بس 📌 مثال: !زواج @فلانة المهر');
        return;
      }
      const husband = await message.getContact();
      const wife = mentioned[0];
      const husbandId = husband.id._serialized;
      const wifeId = wife.id._serialized;
      const chatId = chat.id._serialized;

      if (husbandId === wifeId) {
        await message.reply('ما تقدر تتزوج نفسك يا حكيم 😂');
        return;
      }

      // هل الزوجة محجوزة أصلاً؟
      if (findActiveMarriageAsWife(wifeId, chatId)) {
        await message.reply('هاي محجوزة، دور على وحدة تانية يا بطل 🙅‍♂️');
        return;
      }

      // هل الزوج وصل الحد الأقصى؟
      const husbandWives = findActiveWivesOfHusband(husbandId, chatId);
      if (husbandWives.length >= MAX_WIVES_PER_HUSBAND) {
        await message.reply(`خلاص وصلت الحد يا بطل، عندك ${MAX_WIVES_PER_HUSBAND} وكفاية عليك 😅`);
        return;
      }

      // هل فيه طلب معلق أصلاً لنفس الزوجة بنفس الجروب؟
      const requestKey = `${chatId}_${wifeId}`;
      if (pendingMarriageRequests.has(requestKey)) {
        await message.reply('فيه طلب معلق أصلاً لهاي، خلّي يرد الأول 🕐');
        return;
      }

      // استخراج المهر من النص (لو مكتوب)
      let mahrText = body.replace('!زواج', '').trim();
      mentioned.forEach((c) => {
        mahrText = mahrText.replace(`@${c.number}`, '').trim();
      });
      const mahr = mahrText.length > 0 ? mahrText : randomMahr();

      // تايمر انتهاء المهلة (دقيقتين)
      const timer = setTimeout(async () => {
        if (pendingMarriageRequests.has(requestKey)) {
          pendingMarriageRequests.delete(requestKey);
          try {
            await chat.sendMessage(`@${wife.number} ما ردت بالوقت، الطلب اتلغى ⏳💔`, {
              mentions: [wife]
            });
          } catch (_) {}
        }
      }, MARRIAGE_REQUEST_TIMEOUT_MS);

      pendingMarriageRequests.set(requestKey, { husbandId, wifeId, chatId, mahr, timer });

      await chat.sendMessage(
        `يا @${wife.number}، @${husband.number} يطلب يدك، والمهر: ${mahr} 💍\nعندك دقيقتين، اكتبي *قبول* أو *رفض*`,
        { mentions: [wife, husband] }
      );
      return;
    }

    // -------- 6هـ) قبول / رفض - رد على طلب زواج معلق --------
    if (body === 'قبول' || body === 'رفض') {
      const authorContact = await message.getContact();
      const chatId = chat.id._serialized;
      const requestKey = `${chatId}_${authorContact.id._serialized}`;
      const pending = pendingMarriageRequests.get(requestKey);

      if (pending) {
        clearTimeout(pending.timer);
        pendingMarriageRequests.delete(requestKey);

        if (body === 'رفض') {
          await message.reply('مرفوووض! خيبة يا خويا، جرب حظك مرة تانية بمكان تاني 😂');
          return;
        }

        // قبول: نثبت الزواج
        const marriages = loadMarriages();
        const newMarriage = {
          husbandId: pending.husbandId,
          wifeId: pending.wifeId,
          chatId: pending.chatId,
          mahr: pending.mahr,
          date: new Date().toISOString(),
          status: 'قائم'
        };
        marriages.push(newMarriage);
        saveMarriages(marriages);

        await message.reply(`مبروووك الزواج! ألف مبروك ومهرها كان: ${pending.mahr} 🎉💍`);

        // لو هاي الزوجة الثانية، نبعت رسالة مضحكة للزوجة الأولى
        const husbandWivesNow = findActiveWivesOfHusband(pending.husbandId, pending.chatId);
        if (husbandWivesNow.length === 2) {
          const firstWife = husbandWivesNow[0];
          try {
            const husbandContact = await client.getContactById(pending.husbandId);
            await chat.sendMessage(
              `@${firstWife.wifeId.split('@')[0]} يا حرام، @${husbandContact.number} جاب وحدة ثانية معاك 😂 قومي ديري لِه فنجان قهوة وسكتي 🙃`,
              { mentions: await Promise.all([client.getContactById(firstWife.wifeId), husbandContact]) }
            );
          } catch (err) {
            console.error('فشل إرسال رسالة الزوجة الأولى:', err.message);
          }
        }
        return;
      }
      // لو ماله طلب معلق، نتجاهل الرسالة عادي (ما نرد)
    }

    // -------- 6و) !طلاق @شخص - الزوج بس يقدر يطلق --------
    if (body.startsWith('!طلاق')) {
      if (!chat.isGroup) {
        await message.reply('هاد الأمر يشتغل بالجروبات بس 🙅');
        return;
      }
      const mentioned = await message.getMentions();
      if (!mentioned || mentioned.length !== 1) {
        await message.reply('لازم تعمل منشن لشخص واحد بس 📌 مثال: !طلاق @فلانة');
        return;
      }
      const sender = await message.getContact();
      const target = mentioned[0];
      const chatId = chat.id._serialized;
      const senderId = sender.id._serialized;
      const targetId = target.id._serialized;

      const marriages = loadMarriages();
      // الحالة 1: الزوج يطلق زوجته
      let marriage = marriages.find(
        (m) => m.husbandId === senderId && m.wifeId === targetId && m.chatId === chatId && m.status === 'قائم'
      );

      if (marriage) {
        marriage.status = 'منتهي';
        saveMarriages(marriages);
        await message.reply('تم الطلاق، الله يعوضك بأحسن منها 💔');
        return;
      }

      // الحالة 2: الزوجة حاولت تطلق (ما تقدرش)
      const wifeTryingToDivorce = marriages.find(
        (m) => m.wifeId === senderId && m.husbandId === targetId && m.chatId === chatId && m.status === 'قائم'
      );
      if (wifeTryingToDivorce) {
        await message.reply('انتي ما عندك هالحق يا الغالية، خلي زوجك يقرر 🙅‍♀️');
        return;
      }

      await message.reply('ما فيه زواج قائم بينكم أصلاً 🤷');
      return;
    }

    // -------- 6) !عمي_حسام - يرد على السؤال مع مراعاة سياق المحادثة السابقة --------
    if (body.startsWith('!عمي_حسام') || body.startsWith('!عمي حسام')) {
      if (!aiEnabled) {
        await message.reply('عمي حسام ساكت هلق، اكتب !تشغيل عشان يرجع 🤐');
        return;
      }
      const question = body.replace('!عمي_حسام', '').replace('!عمي حسام', '').trim();
      const prompt = question.length > 0 ? question : 'سلم علينا يا عمي حسام';
      const history = conversationHistory.get(convoKey) || [];
      const reply = await askAI(prompt, history);
      pushToHistory(convoKey, 'user', prompt);
      pushToHistory(convoKey, 'assistant', reply);
      await message.reply(reply);
      return;
    }

    // -------- 7) رد (Reply) على رسالة من عمي حسام نفسه = يرد عليك بدون أمر (رد نصي) --------
    // شرط مهم: لازم يكون رد على رسالة البوت (fromMe)، مش رد على عضو أو الأونر
    // وكمان لازم يكون فيه محتوى حقيقي (مش نقطة أو رمز فاضي) عشان الذكاء الصناعي ميتلخبطش
    // ده بيشتغل كل مرة تكون فيها Reply فعلي على رسالة البوت، عدد المرات مش مهم
    // لو كتب عادي من غير Reply، مش هيرد خالص مهما كان
    if (aiEnabled && message.hasQuotedMsg && body.length > 1 && !body.startsWith('!')) {
      const quotedMsg = await message.getQuotedMessage();
      if (quotedMsg && quotedMsg.fromMe) {
        const history = conversationHistory.get(convoKey) || [];
        const reply = await askAI(body, history);
        pushToHistory(convoKey, 'user', body);
        pushToHistory(convoKey, 'assistant', reply);
        await message.reply(reply);
        return;
      }
    }

    // -------- 8) !صوت - يحول نص لرسالة صوتية بصوت عمي حسام --------
    // استخدام 1: !صوت نص تبيه يتحول صوت
    // استخدام 2: رد (Reply) على رسالة نصية من عمي حسام بـ "!صوت" بدون نص زيادة، يحولها هي لصوت
    if (body.startsWith('!صوت')) {
      if (!aiEnabled) {
        await message.reply('عمي حسام ساكت هلق، اكتب !تشغيل عشان يرجع 🤐');
        return;
      }
      let textToSpeak = body.replace('!صوت', '').trim();

      if (textToSpeak.length === 0 && message.hasQuotedMsg) {
        const quotedMsg = await message.getQuotedMessage();
        if (quotedMsg && quotedMsg.fromMe && quotedMsg.body) {
          textToSpeak = quotedMsg.body;
        }
      }

      if (textToSpeak.length === 0) {
        await message.reply('اكتب النص اللي بدك تحوله صوت، أو رد (Reply) على رسالة من عمي حسام بـ !صوت 🎙️');
        return;
      }

      try {
        const voiceBuffer = await textToVoiceBuffer(textToSpeak);
        const media = new MessageMedia('audio/ogg; codecs=opus', voiceBuffer.toString('base64'));
        await chat.sendMessage(media, { sendAudioAsVoice: true });
      } catch (err) {
        console.error('خطأ بتحويل النص لصوت:', err.message);
        await message.reply('ما قدرت أسوي الصوت هلق، جرب بعد شوي 😅');
      }
      return;
    }

    // -------- 9) رسالة صوتية (Reply على رسالة البوت) = يفرغها، يفهمها، ويرد بصوت --------
    // لازم تكون: رسالة صوتية (ptt) + رد (Reply) على رسالة سابقة من البوت
    if (aiEnabled && (message.type === 'ptt' || message.type === 'audio') && message.hasQuotedMsg) {
      const quotedMsg = await message.getQuotedMessage();
      if (quotedMsg && quotedMsg.fromMe) {
        try {
          const media = await message.downloadMedia();
          if (!media || !media.data) {
            await message.reply('ما قدرت أسمع الصوت، جرب تبعته مرة تانية 😅');
            return;
          }
          const audioBuffer = Buffer.from(media.data, 'base64');
          const transcribedText = await transcribeVoiceBuffer(audioBuffer, media.mimetype);

          if (!transcribedText) {
            await message.reply('ما فهمت شي من الصوت، جرب تحكي أوضح 🎙️');
            return;
          }

          const history = conversationHistory.get(convoKey) || [];
          const aiReply = await askAI(transcribedText, history);
          pushToHistory(convoKey, 'user', transcribedText);
          pushToHistory(convoKey, 'assistant', aiReply);

          const voiceBuffer = await textToVoiceBuffer(aiReply);
          const voiceMedia = new MessageMedia('audio/ogg; codecs=opus', voiceBuffer.toString('base64'));
          await chat.sendMessage(voiceMedia, { sendAudioAsVoice: true });
        } catch (err) {
          console.error('خطأ بمعالجة الرسالة الصوتية:', err.message);
          await message.reply('صار في مشكلة وأنا نسمعك، جرب بعد شوي 😅');
        }
        return;
      }
    }
  } catch (err) {
    console.error('خطأ بمعالجة الرسالة:', err.message);
  }
});

// ============ سيرفر ويب صغير (لازم لـ Render + لعرض QR) ============
const app = express();

app.get('/', async (req, res) => {
  if (clientReady) {
    return res.send(`
      <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding-top:50px;">
      <h1>✅ البوت شغال ومتصل بواتساب</h1>
      </body></html>
    `);
  }

  // لو عندنا كود ربط جاهز، نعرضه
  if (lastPairingCode) {
    return res.send(`
      <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding-top:40px;">
      <h2>افتح واتساب > الإعدادات > الأجهزة المرتبطة > ربط جهاز > ربط برقم الهاتف</h2>
      <h1 style="letter-spacing:6px;font-size:42px;background:#111;color:#0f0;display:inline-block;padding:15px 25px;border-radius:10px;">${lastPairingCode}</h1>
      <p>الكود بينتهي بسرعة، لو ما وصلك بالوقت اعمل ريفريش وجيب كود جديد</p>
      <p><a href="/">🔄 رجوع</a></p>
      </body></html>
    `);
  }

  // نموذج لإدخال الرقم وتوليد كود الربط
  const errorHtml = pairingError
    ? `<p style="color:red;">${pairingError}</p>`
    : '';

  return res.send(`
    <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding-top:30px;">
    <h2>اختر طريقة الربط</h2>

    <h3>1) كود ربط برقم الهاتف</h3>
    <form action="/pair" method="get">
      <input name="number" placeholder="مثال: 9665xxxxxxxx (بدون + وبدون صفر)" style="padding:8px;width:260px;" required />
      <button type="submit" style="padding:8px 16px;">توليد الكود</button>
    </form>
    ${errorHtml}

    <hr style="margin:30px auto;width:300px;" />

    <h3>2) أو امسح QR</h3>
    ${lastQr ? `<img src="${await qrcode.toDataURL(lastQr)}" style="width:260px;height:260px;" />` : '<p>QR لسا ما جهز...</p>'}

    <p>الصفحة بتتحدث تلقائياً كل 5 ثواني</p>
    <script>setTimeout(()=>location.reload(), 5000);</script>
    </body></html>
  `);
});

// نقطة توليد كود الربط برقم الهاتف
app.get('/pair', async (req, res) => {
  const number = req.query.number;
  if (!number) {
    return res.redirect('/');
  }
  if (clientReady) {
    return res.redirect('/');
  }
  try {
    await requestPairingCode(number);
  } catch (err) {
    // الخطأ محفوظ بـ pairingError وبينعرض بالصفحة الرئيسية
  }
  return res.redirect('/');
});

// نقطة فحص صحة السيرفر (يطلبها Render أحياناً)
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`🌐 سيرفر الويب شغال على البورت ${PORT}`);
});

// ============ تشغيل البوت ============
client.initialize();
