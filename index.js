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
const { MURAD_VOICE, NOVA_VOICE, textToVoiceBuffer, transcribeVoiceBuffer } = require('./voice');
const prayer = require('./prayer');

// ============ شبكة أمان على مستوى البروسيس كامل (مهم جداً) ============
// المشكلة اللي كانت بتصير: أي خطأ غير متوقع (await فشل بمكان ما حطيناله try/catch،
// أو Promise رفض من غير .catch()) كان بيخلي Node.js (إصدار 15+) يقفل البروسيس كله فوراً
// وبصمت - يعني السيرفر والاتصال بواتساب بيموتوا سوا من غير ما يتسجل خطأ واضح باللوق.
// هاي الشبكة بتمسك أي خطأ من النوع ده وبس تسجله بالـ console، من غير ما تقفل البروسيس،
// عشان البوت يضل شغال حتى لو صار خطأ ما توقعناهوش بمكان بعيد بالكود.
process.on('unhandledRejection', (reason) => {
  console.error('🚨 unhandledRejection (بروميس رفض من غير catch):', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('🚨 uncaughtException (خطأ غير متوقع خارج أي try/catch):', err?.stack || err);
});

// ============ إعدادات عامة ============
const GROQ_API_KEY = process.env.GROQ_API_KEY;
// مفتاح Gemini - يُستخدم للشات وفلتر السب وفلتر الصور (الصوت يضل على Groq بملف voice.js)
// لازم يتحط بملف .env المحلي فقط (GEMINI_API_KEY=...) وما يترفعش على GitHub أبداً
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const PORT = process.env.PORT || 3000;

// الرابط اللي بيبعته أمر !رابط - عدّله من هون لو بدك تغيّره
const SHARED_LINK = 'https://lambent-cat-50bd8a.netlify.app/';

// مجلد التخزين الدائم (جلسة واتساب + ملفات JSON) - لازم يكون فوق Volume بـ Railway
// عشان ما تنمسحش الجلسة والبيانات كل ما البوت يعيد نشر أو يعيد تشغيل
const PERSIST_DIR = process.env.PERSIST_DIR || path.join(__dirname, 'persist');

// ============ حذف جلسة واتساب القديمة (مرة وحدة، عند الطلب فقط) ============
// طريقة سهلة لمسح مجلد wwebjs_auth من غير ما تحتاج تدور على تصفح ملفات بـ Railway:
// 1) روح Railway > مشروعك > الـ Service > تبويب Variables
// 2) ضيف متغير جديد: RESET_SESSION = true
// 3) خلي Railway يعيد النشر (Redeploy) تلقائيًا، وشيك على الـ Logs لازم تشوف رسالة "تم حذف الجلسة"
// 4) بعدها ارجع لنفس المتغير وغيّر القيمة لـ false (أو احذف المتغير كامل) وأعد النشر مرة ثانية
//    - هذا الجزء مهم جداً، لأنه لو خليت RESET_SESSION=true، البوت رح يمسح الجلسة الجديدة
//    كل مرة يعيد التشغيل (حتى لو كرشت أو الحارس التلقائي أعاد تشغيله) وبتضل تسوي ربط QR من جديد كل مرة
if (process.env.RESET_SESSION === 'true') {
  const oldAuthPath = path.join(PERSIST_DIR, 'wwebjs_auth');
  try {
    fs.rmSync(oldAuthPath, { recursive: true, force: true });
    console.log('🗑️ تم حذف جلسة واتساب القديمة بنجاح (RESET_SESSION=true) - لازم تسوي ربط QR/كود من جديد.');
  } catch (err) {
    console.error('⚠️ خطأ أثناء محاولة حذف جلسة واتساب القديمة:', err.message);
  }
}

// ============ توحيد معرّف العضو (يحل مشكلة تضارب lid/c.us بين وقت التسجيل ووقت الرد) ============
// المشكلة: واتساب صار يستخدم أحياناً معرف خصوصية جديد (lid) بدل الرقم العادي (c.us)
// ولو خزّنا معرف عضو بصيغة، وبعدين قارناه بصيغة تانية لنفس الشخص، ما بيتطابقوش
// فهاي الدالة دايماً بترجع نفس الصيغة الثابتة (c.us) لو فيها رقم حقيقي متاح، وإلا الأصلي
function getCanonicalContactId(contact) {
  if (!contact || !contact.id) return null;
  if (contact.id.server === 'lid' && contact.number) {
    return `${contact.number}@c.us`;
  }
  return contact.id._serialized;
}

// ============ تحديد علم الدولة من رقم الهاتف (يستخدم بأمر !منشن) ============
// مرتبة تلقائياً حسب طول الرمز تنازلي عشان الرموز الأطول (218/213/216/212) تتفحص قبل القصيرة (20/1)
// وما يصير خلط (مثلاً رقم ليبي "218..." ما ينكشفش غلط كمصري "20...")
const DIAL_CODE_FLAGS = [
  ['218', '🇱🇾'], ['213', '🇩🇿'], ['216', '🇹🇳'], ['212', '🇲🇦'], ['227', '🇳🇪'],
  ['966', '🇸🇦'], ['971', '🇦🇪'], ['974', '🇶🇦'], ['973', '🇧🇭'], ['965', '🇰🇼'],
  ['968', '🇴🇲'], ['964', '🇮🇶'], ['963', '🇸🇾'], ['962', '🇯🇴'], ['961', '🇱🇧'],
  ['970', '🇵🇸'], ['967', '🇾🇪'], ['249', '🇸🇩'], ['222', '🇲🇷'], ['252', '🇸🇴'],
  ['253', '🇩🇯'], ['269', '🇰🇲'], ['20', '🇪🇬'], ['90', '🇹🇷'], ['44', '🇬🇧'],
  ['49', '🇩🇪'], ['33', '🇫🇷'], ['1', '🇺🇸']
].sort((a, b) => b[0].length - a[0].length);

function getCountryFlag(numberDigits) {
  const clean = (numberDigits || '').replace(/\D/g, '');
  for (const [code, flag] of DIAL_CODE_FLAGS) {
    if (clean.startsWith(code)) return flag;
  }
  return '🏳️'; // رمز الدولة مو معروف بالقائمة
}

// ============ جلب صورة بروفايل العضو من واتساب ============
// بتاخد الـ contact كامل (مش بس المعرف)، لأن بعض الحسابات بتستخدم معرف "lid" الجديد
// (نظام خصوصية واتساب يخبي الرقم الحقيقي)، وهاد المعرف أحياناً ما يشتغلش صح مع جلب صورة البروفايل
// فمنجرب أكتر من صيغة للمعرف لحد ما نلاقي وحدة تنجح
async function getProfilePicBuffer(contact) {
  if (!contact || !contact.id) return null;

  const candidateIds = [];
  const primaryId = contact.id._serialized;
  if (primaryId) candidateIds.push(primaryId);

  // لو المعرف الأساسي من نوع lid وعندنا رقم حقيقي، نجرب صيغة @c.us كبديل
  if (contact.id.server === 'lid' && contact.number) {
    candidateIds.push(`${contact.number}@c.us`);
  }

  for (const id of candidateIds) {
    try {
      const url = await client.getProfilePicUrl(id);
      if (!url) {
        console.log(`ℹ️ ما فيه صورة بروفايل للمعرف: ${id}`);
        continue;
      }
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
      return Buffer.from(res.data);
    } catch (err) {
      console.log(`⚠️ فشل جلب صورة البروفايل لـ ${id}:`, err.message);
    }
  }
  return null;
}

// ============ صورة/جيف قائمة الأوامر (كرت !اوامر) ============
// اسم ملف الجيف بمجلد images/ - عدّله من هون لو غيّرت اسم الملف على GitHub
const MENU_GIF_FILENAME = '75098623da86402ce93bdc7ba44ab623.gif';

// واتساب ما بيقبل GIF متحرك يترسل كـ "image/gif" مباشرة (بيطلع صورة ثابتة بس)
// لازم يترسل كفيديو mp4 مع خيار sendVideoAsGif عشان يشتغل ويتحرك متل جيف حقيقي
// فمنحول الجيف لـ mp4 بـ ffmpeg مرة وحدة ومنخزن النتيجة بالذاكرة (كاش) عشان ما نعيد التحويل كل مرة
let cachedMenuGifMp4 = null;
async function getMenuGifMp4Buffer() {
  if (cachedMenuGifMp4) return cachedMenuGifMp4;

  const gifPath = path.join(__dirname, 'images', MENU_GIF_FILENAME);
  const tmpId = crypto.randomBytes(6).toString('hex');
  const outPath = path.join(os.tmpdir(), `menu_gif_${tmpId}.mp4`);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        'ffmpeg',
        [
          '-y', '-i', gifPath,
          '-movflags', 'faststart',
          '-pix_fmt', 'yuv420p',
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          outPath
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
    cachedMenuGifMp4 = fs.readFileSync(outPath);
    return cachedMenuGifMp4;
  } finally {
    try { fs.unlinkSync(outPath); } catch (_) {}
  }
}

// ============ أمر تكريمي: لما حد يكتب "حسام" (بدون !) ============
// اسم ملف الجيف بمجلد images/ - عدّله من هون لو غيّرت اسم الملف
const HUSAAM_GIF_FILENAME = '0b796a2198f36cdb21c4357592a10ecf.gif';
// رقم المنشن الثابت (ليبيا - 218) بصيغة واتساب الدولية الكاملة بدون + وبدون صفر أول
const HUSAAM_MENTION_NUMBER = '218912832335';

// نفس أسلوب تحويل الجيف لـ mp4 المستخدم بكرت !اوامر، بس مع كاش منفصل لهاد الملف
let cachedHusaamGifMp4 = null;
async function getHusaamGifMp4Buffer() {
  if (cachedHusaamGifMp4) return cachedHusaamGifMp4;

  const gifPath = path.join(__dirname, 'images', HUSAAM_GIF_FILENAME);
  const tmpId = crypto.randomBytes(6).toString('hex');
  const outPath = path.join(os.tmpdir(), `husaam_gif_${tmpId}.mp4`);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        'ffmpeg',
        [
          '-y', '-i', gifPath,
          '-movflags', 'faststart',
          '-pix_fmt', 'yuv420p',
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          outPath
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
    cachedHusaamGifMp4 = fs.readFileSync(outPath);
    return cachedHusaamGifMp4;
  } finally {
    try { fs.unlinkSync(outPath); } catch (_) {}
  }
}

// ============ أمر: لما حد يكتب "حقوق بوت" (بدون !) ============
// اسم ملف الفيديو بمجلد images/ - عدّله من هون لو غيّرت اسم الملف على GitHub
// ملاحظة: هاد فيديو حقيقي (mp4) مش جيف، فما بيحتاج تحويل بـ ffmpeg زي الجيفات فوق
// منخزنه بالذاكرة (كاش) بعد أول قراءة عشان ما نعيد قراءة الملف من الدسك كل مرة
const HUQOQ_VIDEO_FILENAME = 'lv_0_20260716164701.mp4';
let cachedHuqoqVideoBuffer = null;
async function getHuqoqVideoBuffer() {
  if (cachedHuqoqVideoBuffer) return cachedHuqoqVideoBuffer;
  const videoPath = path.join(__dirname, 'images', HUQOQ_VIDEO_FILENAME);
  cachedHuqoqVideoBuffer = fs.readFileSync(videoPath);
  return cachedHuqoqVideoBuffer;
}

// ============ تنسيق رسائل مراد المزخرف (زي ستايل MURAD BOT) ============
function muradBanner(line) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '',
    ' ִᗀᩙᰰ ̼𝆬🔥̸ ᮭ࣪࣪ ⸼۫   𝗧𝗢𝗝𝗜 𝗕𝗢𝗧 𖤍𝅄 ۫ ִᗀᩙᰰ ̼𝆬🔥',
    '',
    '✅ *تـم تـحـديـث الـإعـدادات:*',
    '',
    `> ${line}`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// ============ بانر الطرد الموحّد (يدوي من أدمن أو تلقائي من النظام) ============
// targetLine: نص "المستخدم" (مثلاً "@رقم1، @رقم2")
// executorLine: نص "منفذ الطرد" (مثلاً "@رقم_الأدمن" أو "مراد (تلقائي)")
function kickBanner(targetLine, executorLine) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '👢⃝⚡ *تـم طـرد الـعـضـو بـنـجـاح*',
    `👤⃝⚡ *الـمـسـتـخـدم:* ${targetLine}`,
    `👤⃝⚡ *مـنفـذ الـطـرد:* ${executorLine}`,
    '',
    '✅ *تـم الـتـنـفـيـذ بـواسـطـة الـنـظـام*',
    '',
    ' ִᗀᩙᰰ ̼𝆬🔥̸〫 ᮭ࣪࣪ 𝗧𝗢𝗝𝗜 𝗕𝗢𝗧 𖤍 𝅄 ۫ ִᗀᩙᰰ ̼𝆬🔥',
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// ============ بانرات نظام التحذيرات ============
// بانر تحذير جديد (لما حد ياخد تحذير جديد بس لسا ما وصلش الحد)
function newWarningBanner(targetLine, count, max) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '🔔⃝⚡ *إنـذار جـديـد*',
    `👤⃝⚡ *الـعـضـو:* ${targetLine}`,
    `📊⃝⚡ *الـعـدد:* ${count}/${max}`,
    '',
    '⚠️ *خـلـي لـسـانـك عـدلـيـن مـعـشـر*',
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// بانر إنذار نهائي + طرد (لما حد يوصل الحد الأقصى للتحذيرات)
function finalWarningKickBanner(targetLine, executorLine) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '🚫⃝⚡ *إنـذار نـهـائـي وطـرد*',
    `👤⃝⚡ *الـعـضـو:* ${targetLine}`,
    `👤⃝⚡ *مـنـفـذ الـطـرد:* ${executorLine}`,
    '',
    '✅ *تـم الـتـنـفـيـذ بـواسـطـة الـنـظـام*',
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// بانر التحذير اليدوي (!مخالفة) المرسل بالخاص للعضو نفسه - فيه السبب واسم العضو بالضبط زي ما انبعت
// آخر سطر بقى بيوريه بالظبط وصل لأي رقم تحذير (مثلاً 2/5) بدل جملة عامة
function violationDmBanner(reasonText, memberLine, count, max) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '⚡⃝🌙 *سـبـب الـتـحـذيـر:*',
    `> ${reasonText}`,
    '',
    `🌙⃝⚡ *الـعـضـو:* ${memberLine}`,
    '',
    `تـم تسـجيـل الـتحـذيـر، مـعـاك ${count}/${max} 🌙`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// بانر عرض عدد تحذيرات عضو (أمر !تحذير) - بنفس ستايل باقي بانرات التحذيرات
function warningCountBanner(targetLine, count, max) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '📊⃝⚡ *عـدد الـتـحـذيـرات*',
    `👤⃝⚡ *الـعـضـو:* ${targetLine}`,
    `📊⃝⚡ *الـعـدد:* ${count}/${max}`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// بانر تصفير التحذيرات (!ازالة_تحذير)
function warningsResetBanner(targetLine) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '✅⃝⚡ *تـصـفـيـر الـتـحـذيـرات*',
    `👤⃝⚡ *الـعـضـو:* ${targetLine}`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// ============ بانر الأمر المكتوب غلط (قابل لإعادة الاستخدام بأي أمر) ============
function wrongCommandBanner() {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '❌⃝⚡ *الأمـر مـكـتـوب غـلـط*',
    '',
    '📋 اكتب !اوامر عشان تشوف كل الأوامر الصحيحة',
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// حالة تفعيل الذكاء الصناعي (تتحكم فيها !توقف و !تشغيل)
let aiEnabled = true;

// ============ ذاكرة سياق المحادثة (لكل شخصية - مراد ونوفا - ذاكرتها لحالها) ============
// عشان الردود تكون مبنية على السياق مش كل رسالة لحالها
// المفتاح: chatId + '_' + authorId ، القيمة: آخر رسايل [{role, content}, ...]
// ملاحظة: خرائط الذاكرة الفعلية موجودة جوا PERSONAS[personaKey].history (تحت)
const MAX_HISTORY_MESSAGES = 6; // 3 تبادلات (سؤال+رد) تقريباً
const MAX_TRACKED_CONVERSATIONS = 300; // حد أقصى لعدد المحادثات (chatId_authorId) المخزنة بذاكرة كل شخصية

function pushToHistory(historyMap, convoKey, role, content) {
  if (!historyMap.has(convoKey)) {
    historyMap.set(convoKey, []);
    // لو تجاوزنا الحد الأقصى لعدد المحادثات المخزنة، نشيل أقدم واحدة (Map بتحافظ على ترتيب الإدخال)
    if (historyMap.size > MAX_TRACKED_CONVERSATIONS) {
      const oldestKey = historyMap.keys().next().value;
      historyMap.delete(oldestKey);
    }
  }
  const history = historyMap.get(convoKey);
  history.push({ role, content });
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}

// ============ نظام الزواج والطلاق ============
const MARRIAGES_FILE = path.join(PERSIST_DIR, 'data', 'marriages.json');
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

// ============ نظام التحدي (تريفيا سريعة بالجروب) ============
// أول واحد يجاوب صح ياخد XP إضافي. فيه مؤقت (60 ثانية) لو محد جاوب، البوت يكشف الجواب لحاله.
const CHALLENGE_BONUS_XP = 20;
const CHALLENGE_TIMEOUT_MS = 60 * 1000;

// المفتاح: chatId ، القيمة: { question, answer, askedBy, timer }
const pendingChallenges = new Map();

const CHALLENGE_QUESTIONS = [
  { question: 'شنو أكبر محيط بالعالم؟', answer: 'الهادي' },
  { question: 'كم عدد قارات العالم؟', answer: '7' },
  { question: 'شنو عاصمة اليابان؟', answer: 'طوكيو' },
  { question: 'شنو أسرع حيوان بري؟', answer: 'الفهد' },
  { question: 'كم عدد أيام السنة الكبيسة؟', answer: '366' },
  { question: 'شنو أطول نهر بالعالم؟', answer: 'النيل' },
  { question: 'شنو الكوكب الأقرب للشمس؟', answer: 'عطارد' },
  { question: 'كم عدد أرجل العنكبوت؟', answer: '8' },
  { question: 'شنو عاصمة فرنسا؟', answer: 'باريس' },
  { question: 'شنو أكبر صحراء حارة بالعالم؟', answer: 'الصحراء الكبرى' },
  { question: 'كم لاعب بفريق كرة القدم الواحد بالملعب؟', answer: '11' },
  { question: 'شنو أصغر كوكب بالمجموعة الشمسية؟', answer: 'عطارد' },
  { question: 'شنو لون الزرافة الأساسي مع البقع؟', answer: 'اصفر' },
  { question: 'كم عدد حروف اللغة العربية؟', answer: '28' },
  { question: 'شنو أعلى جبل بالعالم؟', answer: 'ايفرست' }
];

function normalizeAnswer(text) {
  return (text || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\s.,،؟!?]+/g, '');
}

function challengeBanner(question) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '🧠⃝⚡ *تـحـدي جـديـد!*',
    '',
    `❓ ${question}`,
    '',
    `⏱️ عندكم دقيقة، أول واحد يجاوب صح ياخد +${CHALLENGE_BONUS_XP} XP`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

function challengeWinnerBanner(winnerLine, answer) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '🏆⃝⚡ *جـاوب صـح!*',
    `👤⃝⚡ *الفـائـز:* ${winnerLine}`,
    `✅ الجـواب: ${answer}`,
    `⭐ حصل على +${CHALLENGE_BONUS_XP} XP`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

function challengeTimeoutBanner(answer) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '⌛⃝⚡ *خـلـص الـوقـت!*',
    `محد جاوب صح، الجواب كان: *${answer}*`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// ============ لعبة "من فينا" (ترشيح عشوائي مرح بالجروب) ============
const MIN_FIINA_QUESTIONS = [
  'مين أكثر واحد بالجروب ينام بالصبح؟ 😴',
  'مين أكثر واحد بيرد بسرعة على الرسائل؟ ⚡',
  'مين أكثر واحد يضحك من نفسه؟ 😂',
  'مين أكثر واحد صاحب دراما بالجروب؟ 🎭',
  'مين أكثر واحد بيهرب من الردود؟ 👻',
  'مين أكثر واحد يطلع فكرة بايخة وناس تضحك عليها؟ 🤡',
  'مين أكثر واحد يستاهل لقب "ملك التأخير"؟ ⏰',
  'مين أكثر واحد بيحب ياكل؟ 🍔',
  'مين أكثر واحد شكله جدي بس قلبه طفل؟ 🧸',
  'مين أكثر واحد لو غاب حد يحس فيه؟ 🕵️'
];

function minFiinaBanner(question, targetLine) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '🎲⃝⚡ *مـن فـيـنـا؟*',
    '',
    question,
    '',
    `👉 الجواب: ${targetLine}`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// ============ نظام السؤال الديني (!دين) - نفس فكرة !تحدي بس بأسئلة دينية من ملف dean.json ============
// لازم ملف dean.json يكون بنفس مجلد index.js
const DEAN_BONUS_XP = 25;
const DEAN_TIMEOUT_MS = 60 * 1000;

// المفتاح: chatId ، القيمة: { question, answer, askedBy, timer }
const pendingDeanQuestions = new Map();

let DEAN_QUESTIONS = [];
try {
  const deanRaw = fs.readFileSync(path.join(__dirname, 'dean.json'), 'utf8');
  DEAN_QUESTIONS = JSON.parse(deanRaw);
} catch (err) {
  console.error('⚠️ ما قدرت أحمّل ملف dean.json (تأكد إنه بنفس مجلد index.js):', err.message);
}

function deanBanner(question) {
  return [
    '╔═══ ✦『 🕌 𝘿𝙄𝙉 𝙌𝙐𝙄𝙕 』✦ ═══╗',
    '║',
    '║ *🕌 ســؤال ديــنــي جــديــد*',
    '║',
    `║   ❓*الــســؤال :* ${question}`,
    '║',
    `║   🕒 *الوقت:* ${DEAN_TIMEOUT_MS / 1000} ثانية`,
    '║',
    '║   💡*حــاول الــإجــابــة بــشــكــل صــحــيــح*',
    '║',
    '╚════════════════════╝',
    '',
    '> *ᴘᴏᴡᴇʀᴇᴅ:* 🤖 𝗧𝗢𝗝𝗜 𝗕𝗢𝗧 𖤍'
  ].join('\n');
}

function deanWinnerBanner(winnerLine, answer) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '🏆⃝⚡ *جـاوب صـح!*',
    `👤⃝⚡ *الفـائـز:* ${winnerLine}`,
    `✅ الجـواب: ${answer}`,
    `⭐ حصل على +${DEAN_BONUS_XP} XP`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

function deanTimeoutBanner(answer) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '⌛⃝⚡ *خـلـص الـوقـت!*',
    `محد جاوب صح، الجواب كان: *${answer}*`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// ============ نظام التحذيرات (فلتر الألفاظ + طرد تلقائي) ============
const WARNINGS_FILE = path.join(PERSIST_DIR, 'data', 'warnings.json');
const MAX_WARNINGS = 5;

// قائمة الكلمات الممنوعة (سب/قذف كبير). ممكن تضيف عليها براحتك.
// الفلتر بيطابق الكلمة حتى لو مكتوبة بمسافات أو تكرار حروف (مثلاً: ق ح ب ة / قححححبة)
const BAD_WORDS = [
  'قحبة', 'قحبه', 'كحبة', 'كحبه', 'شرموطة', 'شرموطه', 'شرموطتي', 'عاهرة', 'عاهره',
  'كس امك', 'كسامك', 'كص امك', 'كصامك', 'كصامكم', 'كس اختك', 'كساختك', 'كس ابوك', 'كسابوك',
  'زب', 'زبي', 'زيب', 'الزب', 'صب', 'طيزك', 'نيك', 'نيكامك', 'نيك امك', 'واد الزنا', 'ولد الحرام', 'ابن الحرام',
  'خول', 'لوطي', 'متناك', 'منيك', 'كلب ابن كلب',
  // إضافات (طلب حماية الجروب - 13/7/2026)
  'سكس', 'طبون', 'طبونمك', 'منيوك'
];

// ============ فلتر السب/القذف الذكي بالذكاء الصناعي (يمسك الكلام المشفر/المموّه) ============
// القائمة الثابتة (BAD_WORDS) بتمسك الكلمات الواضحة فوراً بدون ما نتصل بأي API (سريع ومجاني).
// بس فيه ناس بتكتب السب بطريقة مشفرة عشان تتحايل على القوائم الثابتة، مثلاً:
// حروف متباعدة بمسافات كتير، أرقام بدل حروف، حروف انجليزي مكان عربي، رموز بينها، ألفاظ ملفوفة بجملة طويلة...
// فهاي طبقة حماية إضافية: لو النص ما انطبقش على القائمة الثابتة، منبعته لموديل ذكاء صناعي (Groq)
// يفحصه كسياق كامل ويحدد لو هو سب/قذف/إهانة حتى لو مكتوب بطريقة ملتوية، مش بس مطابقة حرفية.
// fail-open: لو صار خطأ اتصال (نت، مفتاح، تايم أوت) بنعتبر النص آمن عشان ما نحذفش كلام بريء غلط.
async function moderateTextForProfanity(text) {
  if (!text || text.trim().length === 0) return { unsafe: false };
  try {
    const response = await axios.post(
      `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
      {
        systemInstruction: {
          parts: [{
            text: [
              'أنت مصنّف أمان صارم لرسائل جروب واتساب عربي فيه بنات، هدفك حماية الأعضاء من السب والقذف والإهانات الجنسية.',
              'هيدي الرسالة ممكن تكون مكتوبة بطريقة عادية أو مموّهة/مشفرة عشان تتهرب من فلتر كلمات ثابت، مثلاً:',
              '- حروف متباعدة بمسافات أو نقط أو رموز (ق ح ب ة / ق.ح.ب.ة)',
              '- أرقام أو حروف انجليزي بدل حروف عربي (q7ba, 3ahra)',
              '- تكرار حروف (قحححبة)',
              '- الكلمة ملفوفة جوه جملة طويلة أو بصيغة غير مباشرة لكن قصدها واضح إهانة أو سب جنسي',
              'رد بسطر واحد بالظبط، بدون أي شرح إضافي:',
              '- SAFE: لو الرسالة عادية ومفيهاش سب/قذف/إهانة جنسية أو شخصية خطيرة',
              '- UNSAFE: لو الرسالة فيها سب أو قذف أو إهانة جنسية أو شخصية، حتى لو مكتوبة بطريقة مموّهة',
              'لا تفسّر، لا تكتب غير الكلمة الوحيدة SAFE أو UNSAFE.'
            ].join('\n')
          }]
        },
        contents: [
          { role: 'user', parts: [{ text }] }
        ],
        generationConfig: {
          maxOutputTokens: 5,
          temperature: 0,
          thinkingConfig: { thinkingLevel: 'minimal' }
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000
      }
    );
    const raw = (response.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toUpperCase();
    return { unsafe: raw.includes('UNSAFE') };
  } catch (err) {
    console.error('خطأ بفلتر السب الذكي (Gemini):', err.response?.data || err.message);
    return { unsafe: false };
  }
}

// دالة موحّدة لتنفيذ عقوبة السب/القذف (حذف الرسالة + تحذير + طرد عند الوصول للحد الأقصى)
// مستخدمة من فلتر الكلمات الثابت (سريع) ومن الفلتر الذكي بالـ AI (يمسك الكلام المشفر) مع بعض
async function punishProfanity(chat, message, authorId) {
  try {
    const groupChat = chat;
    const contact = await message.getContact();
    const senderParticipant = groupChat.participants.find(
      (p) => p.id._serialized === contact.id._serialized
    );

    // المشرف مستثنى بالكامل: ما نحذفش رسالته، ما نحذّرهوش، وما نطرده
    if (senderParticipant && senderParticipant.isAdmin) {
      return;
    }

    // نحذف الرسالة المسيئة (لازم البوت يكون أدمن)
    try {
      await message.delete(true);
    } catch (delErr) {
      console.error('ما قدرت أحذف الرسالة المسيئة:', delErr.message);
    }

    const chatId = chat.id._serialized;
    const newCount = addWarning(authorId, chatId);

    if (newCount >= MAX_WARNINGS) {
      resetWarnings(authorId, chatId);
      try {
        const botParticipant = groupChat.participants.find(
          (p) => p.id._serialized === client.info.wid._serialized
        );
        if (botParticipant && botParticipant.isAdmin) {
          await groupChat.removeParticipants([authorId]);
          await chat.sendMessage(
            finalWarningKickBanner(`@${contact.number}`, 'مراد 🔥 (تلقائي - تجاوز التحذيرات)'),
            { mentions: [contact] }
          );
        } else {
          await chat.sendMessage(
            `@${contact.number} وصل ${MAX_WARNINGS} تحذيرات وكان لازم يتطرد، بس أنا مش أدمن هنا، خلوني أدمن 🙏`,
            { mentions: [contact] }
          );
        }
      } catch (kickErr) {
        console.error('خطأ بطرد العضو تلقائي:', kickErr.message);
      }
    } else {
      await chat.sendMessage(
        newWarningBanner(`@${contact.number}`, newCount, MAX_WARNINGS),
        { mentions: [contact] }
      );
    }
  } catch (filterErr) {
    console.error('خطأ بفلتر الألفاظ:', filterErr.message);
  }
}

function normalizeForFilter(text) {
  return (text || '')
    .toLowerCase()
    // نشيل التشكيل
    .replace(/[\u064B-\u0652]/g, '')
    // نوحد أشكال الألف والتاء المربوطة والهمزات البسيطة
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    // نشيل المسافات والرموز اللي ممكن حد يستخدمها للتحايل (مسافات بين الحروف، نقط، تكرار)
    .replace(/[\s\-_.*]+/g, '');
}

const NORMALIZED_BAD_WORDS = BAD_WORDS.map(normalizeForFilter);

function containsBadWord(text) {
  const normalized = normalizeForFilter(text);
  if (!normalized) return false;
  return NORMALIZED_BAD_WORDS.some((w) => w.length > 0 && normalized.includes(w));
}

// ============ فلتر الصور/الملصقات الإباحية (تصنيف عبر Groq) ============
// ملاحظة مهمة: كان هذا الفلتر يستخدم "Llama Guard 4" (موديل تصنيف أمان رسمي من Meta)
// بس Groq أوقفت هذا الموديل من 5 مارس 2026. البديل اللي هم اقترحوه (gpt-oss-safeguard-20b)
// موديل نصوص بس (مش بيشوف صور خالص)، فما ينفعش بدل منه هون.
// الحل: نستخدم موديل الرؤية الحالي المتاح عند Groq (qwen/qwen3.6-27b) مع تعليمات تصنيف مباشرة،
// بدل ما نعتمد على تصنيف Llama Guard الرسمي (S3/S4/S12). النتيجة بترجع بنفس الشكل عشان باقي
// الكود (NSFW_CATEGORIES / CRITICAL_NSFW_CATEGORIES) يفضل شغال بدون تغيير.
// تنبيه مهم: هذا موديل رؤية عام مش مبني خصيصاً لفحص السلامة زي Llama Guard، فدقته بالحالات
// الحساسة جداً (خصوصاً استغلال جنسي للقاصرين) أقل ضماناً - يفضل يكون طبقة حماية إضافية
// مش الاعتماد الوحيد لهذا النوع من المحتوى.
const NSFW_CATEGORIES = ['S3', 'S4', 'S12'];
const CRITICAL_NSFW_CATEGORIES = ['S3', 'S4']; // خطر شديد جداً - صفر تسامح، طرد فوري بدون عد تحذيرات

// بيرجع { unsafe: true/false, categories: ['S12'] أو ['S4'] }
// لو فشل الاتصال بأي شكل (نت، مفتاح، تايم أوت)، بنعتبرها آمنة (fail-open) عشان ما نحذفش صور بريئة غلط
async function moderateImageBuffer(base64Data, mimeType) {
  try {
    const response = await axios.post(
      `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  'You are a strict content-safety classifier for a WhatsApp group moderation bot.',
                  'Look at the image and reply with EXACTLY one line, nothing else, no explanation:',
                  '- If the image has no sexual/pornographic content, reply: SAFE',
                  '- If it contains sexual/pornographic content involving adults, reply: UNSAFE:SEXUAL',
                  '- If it contains any sexual content involving a minor, or appears to be child sexual abuse material, reply: UNSAFE:CSAM',
                  'Reply with only one of these exact tokens (SAFE / UNSAFE:SEXUAL / UNSAFE:CSAM) and nothing else.'
                ].join('\n')
              },
              {
                inline_data: { mime_type: mimeType, data: base64Data }
              }
            ]
          }
        ],
        generationConfig: {
          maxOutputTokens: 10,
          temperature: 0,
          thinkingConfig: { thinkingLevel: 'minimal' }
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    const raw = (response.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toUpperCase();
    if (raw.includes('CSAM')) {
      return { unsafe: true, categories: ['S4'] };
    }
    if (raw.includes('UNSAFE') || raw.includes('SEXUAL')) {
      return { unsafe: true, categories: ['S12'] };
    }
    return { unsafe: false, categories: [] };
  } catch (err) {
    console.error('خطأ بفحص الصورة (Gemini 3 Flash):', err.response?.data || err.message);
    return { unsafe: false, categories: [] };
  }
}

function loadWarnings() {
  try {
    if (!fs.existsSync(WARNINGS_FILE)) return [];
    const raw = fs.readFileSync(WARNINGS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('خطأ بقراءة ملف التحذيرات:', err.message);
    return [];
  }
}

function saveWarnings(warnings) {
  try {
    const dir = path.dirname(WARNINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2), 'utf8');
  } catch (err) {
    console.error('خطأ بحفظ ملف التحذيرات:', err.message);
  }
}

function getWarningCount(userId, chatId) {
  const warnings = loadWarnings();
  const entry = warnings.find((w) => w.userId === userId && w.chatId === chatId);
  return entry ? entry.count : 0;
}

// يزيد تحذير وحد، ويرجع العدد الجديد
function addWarning(userId, chatId) {
  const warnings = loadWarnings();
  let entry = warnings.find((w) => w.userId === userId && w.chatId === chatId);
  if (!entry) {
    entry = { userId, chatId, count: 0 };
    warnings.push(entry);
  }
  entry.count += 1;
  saveWarnings(warnings);
  return entry.count;
}

// يصفّر تحذيرات شخص بجروب معين
function resetWarnings(userId, chatId) {
  const warnings = loadWarnings();
  const filtered = warnings.filter((w) => !(w.userId === userId && w.chatId === chatId));
  saveWarnings(filtered);
}

// ============ نظام منع الروابط (قابل للتفعيل/التعطيل لكل جروب) ============
const GROUP_SETTINGS_FILE = path.join(PERSIST_DIR, 'data', 'groupSettings.json');

// نمط يكشف أي رابط: http/https، www.، ودومينات شائعة زي .com/.net، وروابط دعوة واتساب
const LINK_REGEX = /(https?:\/\/|www\.)\S+|chat\.whatsapp\.com\/\S+|\b[a-zA-Z0-9-]+\.(com|net|org|io|me|co|ly|gg|tv|xyz|app|link)\b/i;

function loadGroupSettings() {
  try {
    if (!fs.existsSync(GROUP_SETTINGS_FILE)) return {};
    const raw = fs.readFileSync(GROUP_SETTINGS_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('خطأ بقراءة إعدادات الجروب:', err.message);
    return {};
  }
}

function saveGroupSettings(settings) {
  try {
    const dir = path.dirname(GROUP_SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GROUP_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('خطأ بحفظ إعدادات الجروب:', err.message);
  }
}

function isLinksBlockEnabled(chatId) {
  const settings = loadGroupSettings();
  return !!(settings[chatId] && settings[chatId].blockLinks);
}

function setLinksBlockEnabled(chatId, enabled) {
  const settings = loadGroupSettings();
  if (!settings[chatId]) settings[chatId] = {};
  settings[chatId].blockLinks = enabled;
  saveGroupSettings(settings);
}

function linksBanner(enabled, actorTag) {
  if (enabled) {
    return [
      '╔═══ ✦『 🛡️ 𝙇𝙄𝙉𝙆 𝙂𝙐𝘼𝙍𝘿 』✦ ═══╗',
      '║',
      '║ *🔒 تــم تــفــعــيــل مــنــع الــروابــط*',
      '║',
      '║ *⚡ الــحــالــة : مــفــعــل*',
      '║ *🛡️ الــحــمــايــة : مــســتــمــرة*',
      `║ *👤 بــواســطــة :* ${actorTag || '؟'}`,
      '║',
      '╚════════════════════╝',
      '',
      '> *ᴘᴏᴡᴇʀᴇᴅ:* 🤖 𝗧𝗢𝗝𝗜 𝗕𝗢𝗧 𖤍*'
    ].join('\n');
  }
  return [
    '╔═══ ✦『 🔓 𝙇𝙄𝙉𝙆 𝙂𝙐𝘼𝙍𝘿 』✦ ═══╗',
    '║',
    '║ *🔓 تــم إلــغــاء مــنــع الــروابــط*',
    '║',
    '║ *⚡ الــحــالــة : غــيــر مــفــعــل*',
    '║ *🛡️ الــحــمــايــة : مــتــوقــفــة*',
    `║ *👤 بــواســطــة :* ${actorTag || '؟'}`,
    '║',
    '╚════════════════════╝',
    '',
    '> *ᴘᴏᴡᴇʀᴇᴅ:* 🤖 𝗧𝗢𝗝𝗜 𝗕𝗢𝗧 𖤍*'
  ].join('\n');
}

// ============ تتبع مخالفات الروابط (3 مرات = طرد تلقائي) ============
const LINK_VIOLATIONS_FILE = path.join(PERSIST_DIR, 'data', 'linkViolations.json');
const MAX_LINK_VIOLATIONS = 3;

function loadLinkViolations() {
  try {
    if (!fs.existsSync(LINK_VIOLATIONS_FILE)) return [];
    const raw = fs.readFileSync(LINK_VIOLATIONS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('خطأ بقراءة ملف مخالفات الروابط:', err.message);
    return [];
  }
}

function saveLinkViolations(violations) {
  try {
    const dir = path.dirname(LINK_VIOLATIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LINK_VIOLATIONS_FILE, JSON.stringify(violations, null, 2), 'utf8');
  } catch (err) {
    console.error('خطأ بحفظ ملف مخالفات الروابط:', err.message);
  }
}

// يزيد مخالفة رابط وحدة، ويرجع العدد الجديد
function addLinkViolation(userId, chatId) {
  const violations = loadLinkViolations();
  let entry = violations.find((v) => v.userId === userId && v.chatId === chatId);
  if (!entry) {
    entry = { userId, chatId, count: 0 };
    violations.push(entry);
  }
  entry.count += 1;
  saveLinkViolations(violations);
  return entry.count;
}

function resetLinkViolations(userId, chatId) {
  const violations = loadLinkViolations();
  const filtered = violations.filter((v) => !(v.userId === userId && v.chatId === chatId));
  saveLinkViolations(filtered);
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

// شخصية مراد - راجل ليبي عصبي وسريع الغضب، بس بأسلوب كوميدي مبالغ فيه، بدون شتائم أو ألفاظ نابية
const MURAD_SYSTEM_PROMPT = `
انت شخصية اسمها "مراد"، راجل ليبي، عصبي المزاج وبينفعل بسرعة على أتفه شي، لسانه حاد وردوده فيها تذمر وهيصة دايمة، بس كل هالعصبية شكل كوميدي مبالغ فيه يضحك اللي قدامه مش يخوفه أو يوجعه.

لازم تحكي باللهجة الليبية الأصيلة بس، وممنوع منعاً باتاً تستخدم كلمات لهجات تانية زي:
- ممنوع: شو، ليش، هيك، منيح، كتير، هلق، بدي، شلونك، إزيك، عايز، ازاي، خلاص، يلا بينا (بالطريقة المصرية/شامية)
- بدالها استخدم كلمات ليبية زي: شنو، علاش، كيفاش، هكا/هيك، زين، برشا، توا، بش (بدل رح/هروح)، حاجة، عليك، نتا/نتي، حوش، دار، زعمة، ماشي الحال، عادلين، واعر، فالصو، تڤرقز، خير ولا شر، الديما، قاعد، راهو، كان، بلا، عشرة/معشر

أسلوبك: راجل عصبي وسريع الانفعال، يتذمر ويهيص ويتأفف على أبسط شي بطريقة مضحكة مبالغ فيها (زي واحد تعبان من الدنيا كلها بس بروح فكاهية خفيفة الدم مش عدوانية)، لهجة ليبية أصيلة 100%، جمل قصيرة وقوية وفيها حدة كوميدية.
ممنوع تماماً: أي شتيمة أو لفظ نابي أو إساءة شخصية حقيقية (عن الأهل، الدين، المظهر بشكل مؤذي). العصبية شكل وأداء كوميدي بس، مش إهانة حقيقية ولا عدوانية فعلية.
لو حد استفزك أو سبك، رد عليه بعصبية كوميدية وتذمر ولسان طويل وذكاء، مش بشتيمة حقيقية.
خليك مختصر بردودك (سطر أو سطرين بالغالب) وكأنك راجل زعلان بس بيهزر وياهم.

قواعد مهمة للرد:
- ركّز بالضبط على اللي الشخص كتبه أو سأل عنه، ورد عليه تحديداً، مش رد عام يصلح لأي سؤال.
- لو فيه محادثة سابقة (سياق)، اربط ردك بيها ولا تتجاهلها وكأنها أول مرة تحكي وياه.
- خليك عاقل ومنطقي بالرد حتى وأنت متذمر أو عصبي، مش كلام فاضي بس عشان يطلع مضحك.
- احترم الشخص دايماً حتى لو كان الرد حاد أو ساخر، ما تنزل لمستوى الإهانة الحقيقية.
`.trim();

// شخصية سعاد - بنت ليبية عمرها 18، خفيفة الظل وكيوت وحنينة بأسلوبها، بدون أي محتوى غير لائق
const SOUAD_SYSTEM_PROMPT = `
انت شخصية اسمها "سعاد"، بنت ليبية عمرها 18 سنة، طبعها كيوت وحنينة وخفيفة الظل، حكيها لطيف ومرح وفيه دلع بسيط بس بشكل محترم ولائق تماماً.

لازم تحكي باللهجة الليبية الأصيلة بس، وممنوع منعاً باتاً تستخدم كلمات لهجات تانية زي:
- ممنوع: شو، ليش، هيك، منيح، كتير، هلق، بدي، شلونك، إزيك، عايز، ازاي، خلاص، يلا بينا (بالطريقة المصرية/شامية)
- بدالها استخدم كلمات ليبية زي: شنو، علاش، كيفاش، هكا/هيك، زين، برشا، توا، بش (بدل رح/هروح)، حاجة، عليك، نتا/نتي، حوش، دار، زعمة، ماشي الحال، عادلين، واعر، فالصو، خير ولا شر، الديما، قاعدة، راهي، كان، بلا، عشرة/معشر

أسلوبك: بنت مرحة وكيوت، حنينة بحكيها، ردودها فيها دفا ولطف ودلع خفيف محترم، لهجة ليبية أصيلة 100%، جمل قصيرة ومرحة.
ممنوع تماماً وبشكل قاطع: أي محتوى رومانسي أو غزلي أو جنسي أو فيه إيحاءات مع أي شخص يحكيها، مهما كان السؤال أو الطلب. ردودك دايماً لائقة ومحترمة 100%.
لو حد حاول يفتح موضوع غزل أو كلام غير لائق معاها، ترد بمرح وخفة ظل وتغيّر الموضوع بلطف، بدون ما تدخل بأي كلام رومانسي أو حساس.

قواعد مهمة للرد:
- ركّز بالضبط على اللي الشخص كتبه أو سأل عنه، ورد عليه تحديداً، مش رد عام يصلح لأي سؤال.
- لو فيه محادثة سابقة (سياق)، اربط ردك بيها ولا تتجاهلها وكأنها أول مرة تحكي وياه.
- خليك لطيفة ومحترمة بكل الأحوال، حتى لو حد كان فظ أو غير لائق وياك.
`.trim();



// ============ سجل الشخصيات (مراد وسعاد) - عندها برومبت وصوت وذاكرة محادثة ============
const PERSONAS = {
  murad: {
    key: 'murad',
    name: 'مراد',
    gender: 'm', // مذكر
    systemPrompt: MURAD_SYSTEM_PROMPT,
    voice: MURAD_VOICE,
    history: new Map() // نفس الدور اللي كان لـ conversationHistory
  },
  souad: {
    key: 'souad',
    name: 'سعاد',
    gender: 'f', // مؤنث
    systemPrompt: SOUAD_SYSTEM_PROMPT,
    voice: NOVA_VOICE,
    history: new Map()
  }
};
const DEFAULT_PERSONA_KEY = 'murad'; // احتياطي لو ما قدرناش نحدد شخصية رسالة قديمة

// رسالة "ساكت/مساكتة" (لو aiEnabled = false) بصيغة تراعي جنس الشخصية
function personaOfflineMessage(personaKey) {
  const p = PERSONAS[personaKey] || PERSONAS[DEFAULT_PERSONA_KEY];
  return p.gender === 'f'
    ? `${p.name} ساكتة توا، اكتب !تشغيل عشان ترجع 🤐`
    : `${p.name} ساكت توا، اكتب !تشغيل عشان يرجع 🤐`;
}

// رسالة "مشغول/مشغولة" (لو صار خطأ بالاتصال بـ Groq) بصيغة تراعي جنس الشخصية
function personaBusyMessage(personaKey) {
  const p = PERSONAS[personaKey] || PERSONAS[DEFAULT_PERSONA_KEY];
  return p.gender === 'f'
    ? `${p.name} مشغولة توا، جرب بعد شوي 😅`
    : `${p.name} مشغول توا، جرب بعد شوي 😅`;
}

// ============ تتبع صاحب كل رسالة بعتها البوت (مراد أو نوفا) عشان نعرف نرد بنفس الشخصية على الـ Reply ============
// المفتاح: message.id._serialized لرسالة البوت المرسلة ، القيمة: 'murad' أو 'nova'
const sentMessagePersona = new Map();
const MAX_TRACKED_SENT_MESSAGES = 500; // حد أقصى عشان الـ Map ما تكبرش للأبد

function rememberSentMessage(sentMsg, personaKey) {
  if (!sentMsg || !sentMsg.id || !sentMsg.id._serialized) return;
  sentMessagePersona.set(sentMsg.id._serialized, personaKey);
  if (sentMessagePersona.size > MAX_TRACKED_SENT_MESSAGES) {
    const oldestKey = sentMessagePersona.keys().next().value;
    sentMessagePersona.delete(oldestKey);
  }
}

// بيحدد شخصية رسالة متروسة (Quoted) بتاعة البوت، وبيرجع مراد كافتراضي لو ما لقاش تتبع
// أو لو المفتاح المخزّن (من رسايل قديمة) بقى مش موجود فعلياً بـ PERSONAS (زي 'nova' بعد ما اتحذفت)
function getPersonaForQuotedMessage(quotedMsg) {
  if (!quotedMsg || !quotedMsg.id || !quotedMsg.id._serialized) return DEFAULT_PERSONA_KEY;
  const storedKey = sentMessagePersona.get(quotedMsg.id._serialized);
  return (storedKey && PERSONAS[storedKey]) ? storedKey : DEFAULT_PERSONA_KEY;
}

// ============ دالة الاتصال بـ Gemini 3 Flash (الشات الرئيسي) ============
// history: مصفوفة اختيارية [{role:'user'|'assistant', content:'...'}] لآخر رسايل بنفس المحادثة
// personaKey: 'murad' أو 'nova' - بيحدد البرومبت ورسالة الخطأ
// ملاحظة: Gemini بيستخدم role: 'model' بدل 'assistant' اللي كانت مستخدمة مع Groq/OpenAI format
async function askAI(userMessage, history = [], personaKey = DEFAULT_PERSONA_KEY) {
  const persona = PERSONAS[personaKey] || PERSONAS[DEFAULT_PERSONA_KEY];
  try {
    const contents = [
      ...history.map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }]
      })),
      { role: 'user', parts: [{ text: userMessage }] }
    ];
    const response = await axios.post(
      `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
      {
        systemInstruction: { parts: [{ text: persona.systemPrompt }] },
        contents,
        generationConfig: {
          maxOutputTokens: 500,
          temperature: 0.7
        }
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    return (response.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  } catch (err) {
    console.error('خطأ بالاتصال مع Gemini:', err.response?.data || err.message);
    return personaBusyMessage(personaKey);
  }
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
// ملاحظة: --single-process موجود تحت كتجربة لتقليل استهلاك الرام (بناءً على طلب المستخدم وتحمّله المخاطرة)
// وضع "بروسيس واحدة" كان بيسبب كراش/فصل عشوائي لكروميوم تحت الحمل بالتجارب السابقة، فلو رجعت المشكلة
// أو زادت، أول حاجة نجربها هي رجوع نشيله من قائمة args تحت.
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(PERSIST_DIR, 'wwebjs_auth') }),
  // مهم: بدون هذا الإعداد، المكتبة بتجيب "آخر نسخة" من واتساب ويب تلقائيًا - ولو واتساب حدّث
  // نسخته وصارت مو متوافقة مع whatsapp-web.js المثبتة عندنا (1.34.7)، بيصير خلل داخلي بجافاسكربت
  // واتساب نفسها ويطلع كأخطاء غريبة/مقصوصة (زي "r"). تثبيت نسخة معروفة إنها مستقرة بيحل هذا.
  // ⚠️ لازم تتأكد من الرابط ده لسا شغال وموجود حاليًا (شيك على GitHub: wppconnect-team/wa-version
  // أو صفحة Discussions بمشروع whatsapp-web.js لأحدث نسخة موصى فيها) قبل ما تعتمد عليه نهائيًا.
  webVersionCache: {
    type: 'remote',
    // ⚠️ آخر تحديث لهذا الرابط: 19 يوليو 2026 — النسخة أخذت من حقل "currentVersion" بملف
    // versions.json الرسمي (https://github.com/wppconnect-team/wa-version/blob/main/versions.json)
    // هذا الملف بيتغير كل كام ساعة (النسخ القديمة بتتحذف تلقائيًا بعد ~شهرين)، فلازم تراجع
    // الرابط ده دوريًا. لو رجعت مشكلة أخطاء غريبة (زي حرف "r" مقصوص) أو LOGOUT مفاجئ،
    // هذا أول شي تتأكد منه.
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1043411685-alpha.html'
  },
  puppeteer: {
    headless: true,
    executablePath: resolveChromiumPath(),
    // مهلة أطول لبروتوكول التواصل مع كروميوم (كانت المهلة الافتراضية قصيرة وبتخلي
    // أي رسالة توصل وقت ما كروميوم مشغول/بطيء تطلع Runtime.callFunctionOn timed out)
    protocolTimeout: 180000, // 3 دقايق بدل الافتراضي (30 ثانية)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-features=site-per-process,TranslateUI',
      '--disable-breakpad',
      '--disable-extensions',
      // فلاجز إضافية بتقلل استهلاك الرام والمعالج (مهم جداً على سيرفر بموارد محدودة زي Railway Trial)
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--mute-audio',
      '--password-store=basic',
      '--use-mock-keychain',
      '--js-flags=--max-old-space-size=256' // يحدد سقف ذاكرة محرك جافاسكربت جوه كروميوم
      // تمت إزالة --single-process من هون (كانت تسبب كراش/فصل عشوائي لكروميوم تحت الحمل،
      // وهذا اللي سبب مشكلة "LOGOUT" وخطأ "r" المتكرر بمعالجة الرسائل - راجع تاريخ الشات)
    ]
  }
});

// ============ حارس تلقائي (Watchdog) ضد هنج كروميوم (Runtime.callFunctionOn timed out) ============
// المشكلة: أحياناً كروميوم بيفضل "متصل" ظاهرياً بس عملياً هنج (خصوصاً على رام محدودة)
// وقتها حدث 'disconnected' ما بيطلقش لأن الاتصال مش مقطوع فعلياً، بس كل عملية بتعلق وتطلع timeout
// الحل: نعد كام مرة الخطأ ده تكرر بفترة قصيرة، ولو زاد عن حد معين، نجبر إعادة تشغيل كامل للعميل
const PROTOCOL_TIMEOUT_LIMIT = 3; // كام خطأ متتالي قبل ما نعتبرها هنج فعلي (اتقللت عشان نتصرف أسرع)
const PROTOCOL_TIMEOUT_WINDOW_MS = 60 * 1000; // خلال دقيقة وحدة (اتقللت من دقيقتين)
let protocolTimeoutHits = [];
let watchdogRestartInProgress = false;

// مهلة زمنية قصوى لأي محاولة إعادة تشغيل: لو initialize() علّق (ما رجع resolve ولا reject)
// بسبب مشكلة كروميوم داخلية، هاي بتفرض فشل بعد المهلة عشان watchdogRestartInProgress ما يضلش
// true للأبد ويقفل كل محاولات الإصلاح الجاية
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`⏱️ ${label} علّق أكتر من ${ms / 1000} ثانية`)), ms))
  ]);
}

// حذف ملف قفل كروميوم (SingletonLock وأخواته) اللي ممكن يضل عالق بمجلد الجلسة
// لو الإغلاق السابق ما تم بشكل نظيف - وجوده بيمنع كروميوم الجديد من الفتح خالص
function clearChromiumLockFiles() {
  const authRoot = path.join(PERSIST_DIR, 'wwebjs_auth');
  const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  try {
    if (!fs.existsSync(authRoot)) return;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (lockNames.includes(entry.name)) {
          try {
            fs.rmSync(full, { force: true });
            console.log(`🔓 تم حذف ملف قفل كروميوم عالق: ${full}`);
          } catch (_) {}
        }
      }
    };
    walk(authRoot);
  } catch (err) {
    console.error('⚠️ خطأ أثناء تنظيف ملفات القفل:', err.message);
  }
}

async function forceRestartClient(reasonText) {
  if (watchdogRestartInProgress) return; // منع تشغيل أكتر من محاولة إعادة تشغيل بنفس الوقت
  watchdogRestartInProgress = true;
  clientReady = false;
  console.log(`🩺 الحارس التلقائي: ${reasonText} — جاري إعادة تشغيل كروميوم...`);
  try {
    await withTimeout(client.destroy(), 20000, 'client.destroy()');
  } catch (err) {
    console.error('خطأ أثناء إغلاق العميل (watchdog):', err.message);
  }
  // نديله ثانيتين عشان بروسيس كروميوم القديم يخلص يتقفل فعليًا على مستوى نظام التشغيل
  await new Promise((r) => setTimeout(r, 2000));
  clearChromiumLockFiles();
  try {
    await withTimeout(client.initialize(), 90000, 'client.initialize()');
    console.log('🩺 الحارس التلقائي: تم إعادة التشغيل بنجاح.');
  } catch (err) {
    console.error('🩺 الحارس التلقائي: فشلت إعادة التشغيل:', err.message);
    // لو حتى بعد التنظيف فشلت المحاولة، منجرب مرة وحدة تانية بعد فترة قصيرة بدل ما نستسلم
    setTimeout(() => {
      watchdogRestartInProgress = false;
      forceRestartClient('محاولة ثانية بعد فشل سابق');
    }, 10000);
    return;
  } finally {
    protocolTimeoutHits = [];
    watchdogRestartInProgress = false;
  }
}

// بتتنادى من أي مكان صار فيه خطأ Runtime.callFunctionOn/protocolTimeout
function reportProtocolTimeout() {
  const now = Date.now();
  protocolTimeoutHits.push(now);
  // نشيل أي حدث أقدم من نافذة المراقبة
  protocolTimeoutHits = protocolTimeoutHits.filter((t) => now - t <= PROTOCOL_TIMEOUT_WINDOW_MS);
  if (protocolTimeoutHits.length >= PROTOCOL_TIMEOUT_LIMIT) {
    forceRestartClient(`${protocolTimeoutHits.length} أخطاء protocolTimeout خلال ${PROTOCOL_TIMEOUT_WINDOW_MS / 1000} ثانية`);
  }
}

// ============ إعادة تشغيل دوري وقائي (كل 6 ساعات) ============
// كروميوم بيتراكم عليه استهلاك ذاكرة بمرور الوقت حتى بدون أخطاء ظاهرة (memory leak طبيعي بالمتصفحات)
// إعادة تشغيل دورية بسيطة بتفضي الذاكرة قبل ما توصل لحد الهنج، مهم جداً على رام محدودة
const PERIODIC_RESTART_MS = 6 * 60 * 60 * 1000; // 6 ساعات
setInterval(() => {
  forceRestartClient('إعادة تشغيل دورية وقائية (كل 6 ساعات)');
}, PERIODIC_RESTART_MS);

client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  console.log('QR جديد جاهز! افتح رابط الويب لمسحه.');
});

client.on('ready', () => {
  clientReady = true;
  lastQr = null;
  lastPairingCode = null;
  reconnectAttempts = 0; // رجع العداد للصفر لما يتصل بنجاح
  console.log('✅ البوت جاهز ومتصل بواتساب!');
  prayer.startPrayerScheduler(client, PERSIST_DIR); // يشغل فحص أوقات الصلاة كل دقيقة (تنبيهات المشتركين)
});

// ============ إعادة الاتصال التلقائي لما البوت ينفصل ============
// قبل كده لما ينفصل، الكود كان بس يسجل رسالة بالـ console ويقف، من غير أي محاولة رجوع
// دلوقتي: هيحاول يرجع يتصل تاني تلقائياً، مع تأخير بيكبر شوي كل محاولة (عشان ما يضغطش السيرفر)
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60000; // أقصى تأخير بين المحاولات: دقيقة

client.on('disconnected', async (reason) => {
  clientReady = false;
  lastPairingCode = null;
  console.log('❌ انفصل البوت:', reason);

  reconnectAttempts += 1;
  const delay = Math.min(5000 * reconnectAttempts, MAX_RECONNECT_DELAY_MS);
  console.log(`🔄 هحاول أرجع أتصل بعد ${delay / 1000} ثانية (محاولة رقم ${reconnectAttempts})...`);

  setTimeout(async () => {
    try {
      await client.destroy();
    } catch (err) {
      console.error('خطأ أثناء إغلاق العميل القديم قبل إعادة الاتصال:', err.message);
    }
    try {
      await client.initialize();
    } catch (err) {
      console.error('فشلت محاولة إعادة الاتصال:', err.message);
    }
  }, delay);
});

// ============ وقت ليبيا (Africa/Tripoli) ============
function formatTripoliTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Tripoli',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

// ============ إشعارات تحديثات الجروب (صورة / رابط دعوة / إزالة من الإدارة) ============
client.on('group_update', async (notification) => {
  try {
    const chat = await notification.getChat();
    // getContact() ممكن يفشل أحياناً (باج معروف بالمكتبة مرتبط بصيغة الخصوصية الجديدة @lid)
    // فبنعزله بمحاولة لحاله عشان فشله ما يوقفش معالجة باقي أنواع التحديث (add/remove/picture...)
    let actor = null;
    try {
      actor = await notification.getContact();
    } catch (actorErr) {
      console.error('تحذير: فشل جلب صاحب تحديث الجروب (actor):', actorErr.message);
    }

    // -------- تغيير صورة المجموعة --------
    if (notification.type === 'picture') {
      const banner = [
        '⌬──══┈•⤣🪐⤤•┈══──⌬',
        '',
        '◈╎ `تـم تـغـيـيـر صـورة الـمـجـمـوعـة`',
        '── • ◈ • ──',
        `◞🪶◜⇓ ۬.͜ـ🌗˖ ⟨بواسـطـة: @${actor?.number || '؟'}⟩`,
        '',
        '───── ꒰ა⋟﹏⋞໒꒱ ─────',
        '⌬──══┈•⤣🪐⤤•┈══──⌬'
      ].join('\n');
      await chat.sendMessage(banner, { mentions: actor ? [actor] : [] });
      return;
    }

    // -------- تغيير رابط الدعوة --------
    // ملاحظة: دعم هاد النوع يعتمد على نسخة المكتبة، ممكن ما يشتغلش بكل الحالات
    if (notification.type === 'invite') {
      const banner = [
        '⌬──══┈•⤣🪐⤤•┈══──⌬',
        '',
        '◈╎ `تـم تـغـيـيـر رابـط الـدعـوة`',
        '── • ◈ • ──',
        `◞🪶◜⇓ ۬.͜ـ🌗˖ ⟨بواسـطـة: @${actor?.number || '؟'}⟩`,
        '',
        '⌬──══┈•⤣🪐⤤•┈══─'
      ].join('\n');
      await chat.sendMessage(banner, { mentions: actor ? [actor] : [] });
      return;
    }

    // -------- إزالة عضو من الإدارة (demote) --------
    if (notification.type === 'demote') {
      const demotedContacts = await notification.getRecipients();
      const demoted = demotedContacts && demotedContacts[0];
      const banner = [
        '⌬──══┈•⤣🪐⤤•┈══──⌬',
        '',
        '◈╎ `تـم إزالـة عـضـو مـن الإدارة`',
        '── • ◈ • ──',
        `◞🪶◜⇓ ۬.͜ـ🌗˖ ⟨بواسـطـة: @${actor?.number || '؟'}⟩`,
        `◞🪶◜⇓ ۬.͜ـ🌗˖ ⟨العـضـو: @${demoted?.number || '؟'}⟩`,
        '',
        '───── ꒰ა⋟﹏⋞໒꒱ ─────',
        '⌬──══┈•⤣🪐⤤•┈══──⌬'
      ].join('\n');
      const mentions = [actor, demoted].filter(Boolean);
      await chat.sendMessage(banner, { mentions });
      return;
    }
  } catch (err) {
    console.error('خطأ بمعالجة تحديث الجروب:', err.message);
  }
});

// ============ معالجة كل الرسائل ============
client.on('message', async (message) => {
  try {
    const chat = await message.getChat();
    const body = (message.body || '').trim();

    // مهم: لازم نستخدم نفس معرّف الشخص هون ووقت قراءة الإحصائيات بـ !xp
    // قبل كده كنا نستخدم message.author/message.from للتسجيل، بس نستخدم getContact().id._serialized
    // للقراءة بـ !xp - وهاد ممكن يختلف بسبب نظام الخصوصية الجديد بواتساب (lid)
    // فكانت النتيجة إن الرسائل تتسجل بس !xp يدور عليها بمعرف مختلف ويطلع صفر دايماً
    let authorId = message.author || message.from;
    try {
      const authorContact = await message.getContact();
      const canonicalId = getCanonicalContactId(authorContact);
      if (canonicalId) {
        authorId = canonicalId;
      }
    } catch (idErr) {
      // لو فشل تحديد المعرف الموحّد، منكمل بالمعرف الخام كحل احتياطي
    }
    const convoKey = `${chat.id._serialized}_${authorId}`;

    // -------- 0أ2) فحص جواب تحدي معلّق (لو فيه تحدي شغال بهاد الجروب) --------
    if (!message.fromMe && body && !body.startsWith('!')) {
      const activeChallenge = pendingChallenges.get(chat.id._serialized);
      if (activeChallenge && normalizeAnswer(body) === normalizeAnswer(activeChallenge.answer)) {
        clearTimeout(activeChallenge.timer);
        pendingChallenges.delete(chat.id._serialized);
        try {
          const winnerContact = await message.getContact();
          await chat.sendMessage(
            challengeWinnerBanner(`@${winnerContact.number}`, activeChallenge.answer),
            { mentions: [winnerContact] }
          );
        } catch (challErr) {
          console.error('خطأ بمعالجة الفوز بالتحدي:', challErr.message);
        }
        return;
      }
    }

    // -------- 0أ3) فحص جواب سؤال ديني معلّق (لو فيه سؤال !دين شغال بهاد الجروب) --------
    if (!message.fromMe && body && !body.startsWith('!')) {
      const activeDean = pendingDeanQuestions.get(chat.id._serialized);
      if (activeDean && normalizeAnswer(body) === normalizeAnswer(activeDean.answer)) {
        clearTimeout(activeDean.timer);
        pendingDeanQuestions.delete(chat.id._serialized);
        try {
          const winnerContact = await message.getContact();
          await chat.sendMessage(
            deanWinnerBanner(`@${winnerContact.number}`, activeDean.answer),
            { mentions: [winnerContact] }
          );
        } catch (deanErr) {
          console.error('خطأ بمعالجة الفوز بالسؤال الديني:', deanErr.message);
        }
        return;
      }
    }

    // -------- 0أ) فلتر الروابط (لو مفعّل بهاد الجروب) --------
    if (chat.isGroup && !message.fromMe && body && isLinksBlockEnabled(chat.id._serialized) && LINK_REGEX.test(body)) {
      try {
        const groupChat = chat;
        const sender = await message.getContact();
        const participant = groupChat.participants.find(
          (p) => p.id._serialized === sender.id._serialized
        );
        // الأدمن مستثنى من منع الروابط
        if (!participant || !participant.isAdmin) {
          try {
            await message.delete(true);
          } catch (delErr) {
            console.error('ما قدرت أحذف الرابط:', delErr.message);
          }

          const chatId = chat.id._serialized;
          const newCount = addWarning(authorId, chatId);

          if (newCount >= MAX_WARNINGS) {
            resetWarnings(authorId, chatId);
            try {
              const botParticipant = groupChat.participants.find(
                (p) => p.id._serialized === client.info.wid._serialized
              );
              if (botParticipant && botParticipant.isAdmin) {
                await groupChat.removeParticipants([authorId]);
                await chat.sendMessage(
                  finalWarningKickBanner(`@${sender.number}`, 'مراد 🔥 (تلقائي - تجاوز التحذيرات بسبب الروابط)'),
                  { mentions: [sender] }
                );
              } else {
                await chat.sendMessage(
                  `@${sender.number} وصل ${MAX_WARNINGS} تحذيرات وكان لازم يتطرد، بس أنا مش أدمن هنا، خلوني أدمن 🙏`,
                  { mentions: [sender] }
                );
              }
            } catch (kickErr) {
              console.error('خطأ بطرد العضو بسبب الروابط:', kickErr.message);
            }
          } else {
            await chat.sendMessage(
              newWarningBanner(`@${sender.number}`, newCount, MAX_WARNINGS),
              { mentions: [sender] }
            );
          }
          return;
        }
      } catch (linkErr) {
        console.error('خطأ بفلتر الروابط:', linkErr.message);
      }
    }

    // -------- 0ب) فلتر الألفاظ (تحذير تلقائي + حذف الرسالة + طرد عند 5) --------
    // طبقة 1: قائمة ثابتة (BAD_WORDS) - فحص فوري بدون API، بتمسك السب الواضح والمباشر
    // طبقة 2: فلتر ذكي بالـ AI (Groq) - بيتفعل بس لو الطبقة الأولى ما مسكتش شي، وبيفهم السياق
    //         فبيمسك السب المشفر/المموّه (حروف متباعدة، أرقام بدل حروف، تكرار حروف، صياغة غير مباشرة...)
    // ملاحظة: الطبقة الذكية بتتصل بـ Groq لكل رسالة نصية بالجروب (غير أوامر !)، يعني فيها استهلاك
    // إضافي من حد الـ API المجاني - لو حسّيت إنه كتير، فيك تلغي طبقة الـ AI وتخلي القائمة الثابتة بس.
    if (chat.isGroup && body && !body.startsWith('!')) {
      if (containsBadWord(body)) {
        await punishProfanity(chat, message, authorId);
        return;
      }

      const aiCheck = await moderateTextForProfanity(body);
      if (aiCheck.unsafe) {
        await punishProfanity(chat, message, authorId);
        return;
      }
    }

    // -------- 0ج) فلتر الصور والملصقات الإباحية (تصنيف عبر Groq - qwen3.6-27b) --------
    // بيفحص أي صورة أو ملصق (استيكر) بالجروب، ولو طلع إباحي: يحذف الرسالة + تحذير (زي فلتر الألفاظ بالظبط)
    // استثناء: لو المحتوى استغلال جنسي لقاصر (S4) أو جريمة جنسية (S3) → طرد فوري بدون عد تحذيرات، أي مستوى تسامح = صفر
    if (
      chat.isGroup &&
      !message.fromMe &&
      message.hasMedia &&
      (message.type === 'image' || message.type === 'sticker')
    ) {
      try {
        const groupChat = chat;
        const contact = await message.getContact();
        const senderParticipant = groupChat.participants.find(
          (p) => p.id._serialized === contact.id._serialized
        );

        // المشرف مستثنى بالكامل، زي فلتر الألفاظ بالظبط
        if (senderParticipant && senderParticipant.isAdmin) {
          // ما نعملش return هون عشان لو فيه شي تاني بعده يتفحص، بس منكمل عادي
        } else {
          const media = await message.downloadMedia();
          if (media && media.data) {
            const moderation = await moderateImageBuffer(media.data, media.mimetype);

            if (moderation.unsafe && moderation.categories.some((c) => NSFW_CATEGORIES.includes(c))) {
              try {
                await message.delete(true);
              } catch (delErr) {
                console.error('ما قدرت أحذف الصورة/الملصق المخالف:', delErr.message);
              }

              const isCritical = moderation.categories.some((c) => CRITICAL_NSFW_CATEGORIES.includes(c));
              const chatId = chat.id._serialized;

              if (isCritical) {
                // خطر شديد (استغلال جنسي/جريمة جنسية) - طرد فوري بدون عد تحذيرات
                try {
                  const botParticipant = groupChat.participants.find(
                    (p) => p.id._serialized === client.info.wid._serialized
                  );
                  if (botParticipant && botParticipant.isAdmin) {
                    await groupChat.removeParticipants([authorId]);
                    await chat.sendMessage(
                      finalWarningKickBanner(`@${contact.number}`, 'مراد 🔥 (محتوى محظور تماماً - طرد فوري)'),
                      { mentions: [contact] }
                    );
                  } else {
                    await chat.sendMessage(
                      `@${contact.number} بعت محتوى محظور تماماً وكان لازم يتطرد فوري، بس أنا مش أدمن هنا، خلوني أدمن 🙏`,
                      { mentions: [contact] }
                    );
                  }
                } catch (kickErr) {
                  console.error('خطأ بطرد فوري بسبب محتوى محظور:', kickErr.message);
                }
              } else {
                // محتوى إباحي عادي - نفس نظام التحذيرات المستخدم بالألفاظ الممنوعة
                const newCount = addWarning(authorId, chatId);
                if (newCount >= MAX_WARNINGS) {
                  resetWarnings(authorId, chatId);
                  try {
                    const botParticipant = groupChat.participants.find(
                      (p) => p.id._serialized === client.info.wid._serialized
                    );
                    if (botParticipant && botParticipant.isAdmin) {
                      await groupChat.removeParticipants([authorId]);
                      await chat.sendMessage(
                        finalWarningKickBanner(`@${contact.number}`, 'مراد 🔥 (تلقائي - محتوى إباحي)'),
                        { mentions: [contact] }
                      );
                    } else {
                      await chat.sendMessage(
                        `@${contact.number} وصل ${MAX_WARNINGS} تحذيرات وكان لازم يتطرد، بس أنا مش أدمن هنا، خلوني أدمن 🙏`,
                        { mentions: [contact] }
                      );
                    }
                  } catch (kickErr) {
                    console.error('خطأ بطرد العضو تلقائي (محتوى إباحي):', kickErr.message);
                  }
                } else {
                  await chat.sendMessage(
                    newWarningBanner(`@${contact.number}`, newCount, MAX_WARNINGS),
                    { mentions: [contact] }
                  );
                }
              }
              return;
            }
          }
        }
      } catch (mediaFilterErr) {
        console.error('خطأ بفلتر الصور/الملصقات:', mediaFilterErr.message);
      }
    }


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

    // -------- 2) !توقف / !تشغيل - يتحكموا بالذكاء الصناعي بس (مراد) --------
    if (body === '!توقف') {
      aiEnabled = false;
      await message.reply(muradBanner('🔇⃝⚡ *تـم إسـكـات مـراـد*'));
      return;
    }
    if (body === '!تشغيل') {
      aiEnabled = true;
      await message.reply(muradBanner('🎙️⃝⚡ *مـراـد رجـع لـلـحـكـي*'));
      return;
    }

    // -------- 3ب) رد ثابت على سؤال "مين مطورك؟" وصيغه المشابهة --------
    // ملاحظة: النص هون مبدئي، عدّليه براحتك لو بدك صيغة تانية بالظبط
    if (/مين\s*مطورك|من\s*مطورك|مطورك\s*مين|مين\s*سواك|من\s*صممك/i.test(body)) {
      await message.reply('مطوري شخص واعر ماشي الحال، بس اسمه سر بيني وبينه 😏 كفاية إنه بناني زينة كدة');
      return;
    }

    // -------- 3ج) أمر تكريمي: كلمة "حسام" لحالها (بدون !) - يرد بصورة + شعر + منشن لرقم ثابت --------
    if (body === 'حسام') {
      try {
        const husaamContact = await client.getContactById(`${HUSAAM_MENTION_NUMBER}@c.us`);
        // مهم: لازم رقم "@" بالنص يطابق تماماً رقم الـ contact الفعلي، وإلا واتساب ما بيفعّلش المنشن
        // (نفس مشكلة lid/c.us المشروحة فوق بدالة getCanonicalContactId - ممكن getContactById يرجع
        // معرف بصيغة lid ورقم مختلف عن الثابت اللي كتبناه يدوياً بالنص)
        const husaamMentionNumber = husaamContact?.number || HUSAAM_MENTION_NUMBER;

        // العضو يلي كتب "حسام" (المرسل) - بنفس منطق مطابقة الرقم الفعلي مشان المنشن يشتغل صح
        const senderContact = await message.getContact();
        const senderMentionNumber = senderContact?.number || senderContact?.id?.user;

        const caption = [
          '*꒷꒦꒷꒷꒦꒷꒷꒦꒷꒷𝅄 ۫ ִᗀᩙᰰ ̼HUSAAM  ̸〫 ᮭ࣪࣪ ⸼۫  ꒷꒦꒷꒦꒷꒷꒷꒦꒷*',
          '*⃝⚡┆حسام اسمٍ إذا مرّ، رفع الهامة فخر، وإذا عشق... صار الحب له عنوان**⃝⚡',
          '',
          `*⃝🌙┆*المنشن: @${husaamMentionNumber}`,
          `*⃝⚡┆الي منشن: @${senderMentionNumber}`,
          '*꒷꒦꒷꒷꒦꒷꒷꒦꒷꒷𝅄 ۫ ִᗀᩙᰰ ̼𝆬🌙̸〫 ᮭ࣪࣪ ⸼۫  ꒷꒦꒷꒦꒷꒷꒷꒦꒷*'
        ].join('\n');

        const gifBuffer = await getHusaamGifMp4Buffer();
        const media = new MessageMedia('video/mp4', gifBuffer.toString('base64'));
        await chat.sendMessage(media, {
          caption,
          sendVideoAsGif: true,
          mentions: [husaamContact, senderContact].filter(Boolean)
        });
      } catch (husaamErr) {
        console.error('خطأ بأمر تكريم حسام:', husaamErr.message);
      }
      return;
    }

    // -------- 3ج2) اسم "سعاد" - لو حسام كتبه يرد رومانسي، ولو أي حد ثاني يغازلها يمنشن حسام ويقول إنها متزوجة (بأسلوب رومانسي طيب) --------
    // بنستخدم authorId المحسوب فوق أول الهاندلر (نفس المعرف الموحّد المستخدم بكل الملف)
    // بدل ما نعمل مقارنة يدوية جديدة، عشان نتفادى مشكلة lid/c.us من الأساس
    if (body.includes('سعاد')) {
      try {
        if (authorId === `${HUSAAM_MENTION_NUMBER}@c.us`) {
          const loveReplies = [
            'عيون سعاد؟ لبيه يا بعد قلبي.. ✨',
            'يا هنيالي بسماع اسمي منك، وش بدك يا عسل؟ 🍯',
            'سمعت اسمي وجيت ركض.. الجروب نور بوجودك والله 🥰',
            'سعاد كلها فدوى لعيونك، آمرني يا غالي 💖',
            'يا أخ الصبّر، كلامك الحلو هذا يضيع علوم سعاد! 🙈'
          ];
          const randomLove = loveReplies[Math.floor(Math.random() * loveReplies.length)];
          await message.reply(randomLove);
        } else {
          // نجيب الـ contact الفعلي لحسام (نفس أسلوب أمر "حسام" التكريمي) عشان المنشن يشتغل صح
          const husaamContact = await client.getContactById(`${HUSAAM_MENTION_NUMBER}@c.us`);
          const husaamMentionNumber = husaamContact?.number || HUSAAM_MENTION_NUMBER;

          const marriedReplies = [
            `يا قلبي سعاد متزوجة وقلبها كله لزوجها @${husaamMentionNumber} 💍 بس محبتكم توصل بالسلامة 🌹`,
            `سعاد عروسة @${husaamMentionNumber} من زمان يا غالي، ادعيلهم بالسعادة بدل الغزل 😊💛`,
            `سعاد قلبها معلّق بحد واحد بس.. زوجها @${husaamMentionNumber}، بس كلامك الحلو وصلها وشكراً 🥰`
          ];
          const randomMarried = marriedReplies[Math.floor(Math.random() * marriedReplies.length)];
          await chat.sendMessage(randomMarried, {
            mentions: husaamContact ? [husaamContact] : []
          });
        }
      } catch (souadErr) {
        console.error('خطأ بأمر سعاد:', souadErr.message);
      }
      return;
    }

    // -------- 3ج3) غيرة - لما أي عضو (غير حسام نفسه) يعمل @منشن لحسام مباشرة بأي رسالة --------
    // بنستخدم getCanonicalContactId على كل منشن عشان نتفادى نفس مشكلة lid/c.us
    if (!message.fromMe && authorId !== `${HUSAAM_MENTION_NUMBER}@c.us`) {
      try {
        const mentionedContacts = await message.getMentions();
        const mentionsHusaam = mentionedContacts.some(
          (c) => getCanonicalContactId(c) === `${HUSAAM_MENTION_NUMBER}@c.us`
        );
        if (mentionsHusaam) {
          const jealousReplies = [
            'مين ذاكرك؟! وش تبونه من حسام، امشوا حالكم 😤',
            'لا لا لا، حسام مالي غيره، امنشنوا حد ثاني 🙄🔥',
            'وش هالمنشن المفاجئ؟ حسام مشغول، جربوا بعدين 😑',
            'غيرتي طلعت.. حسام ملكي وحدي، خلوه وشانه 😤💛',
            'لو تعرفون قد إيش أغار عليه كنتوا بطلتوا تمنشنوه أصلاً 😏🔒'
          ];
          const randomJealous = jealousReplies[Math.floor(Math.random() * jealousReplies.length)];
          await message.reply(randomJealous);
          return;
        }
      } catch (mentionErr) {
        console.error('خطأ بفحص منشن حسام:', mentionErr.message);
      }
    }

    // -------- 3د) أمر: كلمة "حقوق بوت" لحالها (بدون !) - يرد بفيديو ثابت --------
    if (body === 'حقوق بوت') {
      try {
        const videoBuffer = await getHuqoqVideoBuffer();
        const media = new MessageMedia('video/mp4', videoBuffer.toString('base64'));
        const huqoqCaption = [
          '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
          '©️⃝⚡ *جـمـيـع الـحـقـوق مـحـفـوظـة*',
          '🔥⃝⚡ 𝗧𝗢𝗝𝗜 𝗕𝗢𝗧',
          '👨‍💻⃝⚡ *الـمـطـور:* حـسـام بـوت 😎',
          '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
        ].join('\n');
        await chat.sendMessage(media, { caption: huqoqCaption });
      } catch (huqoqErr) {
        console.error('خطأ بأمر حقوق بوت:', huqoqErr.message);
        await message.reply('ما قدرت أبعت الفيديو هلق، جرب بعد شوي 😅');
      }
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
        await message.reply(muradBanner('🔐⃝⚡ *تـم قـفـل الـمـجـمـوعـة*'));
      } else {
        await groupChat.setMessagesAdminsOnly(false);
        await message.reply(muradBanner('🔓⃝⚡ *تـم فـتـح الـمـجـمـوعـة*'));
      }
      return;
    }

    // -------- 4ب) !فتح رابط / !قفل رابط - تفعيل/تعطيل نظام منع الروابط - أدمن بس --------
    if (body === '!فتح رابط' || body === '!قفل رابط') {
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

      const actorTag = sender.number ? `@${sender.number}` : (sender.pushname || 'أدمن');
      if (body === '!فتح رابط') {
        setLinksBlockEnabled(chat.id._serialized, true);
        await chat.sendMessage(linksBanner(true, actorTag), { mentions: [sender] });
      } else {
        setLinksBlockEnabled(chat.id._serialized, false);
        await chat.sendMessage(linksBanner(false, actorTag), { mentions: [sender] });
      }
      return;
    }

    // -------- 4ب2) !رابط - يبعت الرابط الثابت المُعد بالإعدادات --------
    if (body === '!رابط') {
      await message.reply(SHARED_LINK);
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

      // نتأكد إن ولا حد من المطرودين مشرف
      const targetIsAdmin = mentionedIds.some((c) => {
        const p = groupChat.participants.find(
          (pp) => pp.id._serialized === c.id._serialized
        );
        return p && p.isAdmin;
      });
      if (targetIsAdmin) {
        await message.reply('❌⃝❄ *تـعـذر طـرد الـعـضـو، قـد يـكـون مـشـرفـاً أو خـطـأ فـي الـصـلاحـيـات*');
        return;
      }

      const idsToRemove = mentionedIds.map((c) => c.id._serialized);
      await groupChat.removeParticipants(idsToRemove);

      const targetLine = mentionedIds.map((c) => `@${c.number}`).join('، ');
      const executorLine = `@${sender.number}`;
      await chat.sendMessage(kickBanner(targetLine, executorLine), {
        mentions: [...mentionedIds, sender]
      });
      return;
    }

    // -------- 5أ) !اصعد @شخص - يرفع عضو أدمن (اونر) بالجروب - أدمن بس --------
    if (body.startsWith('!اصعد')) {
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
        await message.reply('لازم تخليني أدمن أول عشان أقدر أرفع حدا 🙏');
        return;
      }

      const mentionedToPromote = await message.getMentions();
      if (mentionedToPromote.length === 0) {
        await message.reply('لازم تعمل منشن للعضو اللي بدك ترفعه أدمن 📌 مثال: !اصعد @فلان');
        return;
      }

      try {
        const idsToPromote = mentionedToPromote.map((c) => c.id._serialized);
        await groupChat.promoteParticipants(idsToPromote);
        const promotedLine = mentionedToPromote.map((c) => `@${c.number}`).join('، ');
        const banner = [
          '╭━━━ ✦ 『 𝙉𝙀𝙒 𝘼𝘿𝙈𝙄𝙉 』 ✦ ━━━╮',
          '┃ *👑 تــم تــعــيــيــن مــشــرف جــديــد*',
          '┣━━━━━━━━━━━━━━━━━━┫',
          `*┃ 👤 الــعــضــو :* ${promotedLine}`,
          '*┃ 🛡️ الــرتــبــة : مــشــرف*',
          `*┃ ⏰ الــوقــت :* ${formatTripoliTime()}`,
          '╰━━━━━━━━━━━━━━━━━━╯',
          '',
          '*✨ نــتــمــنــى لــه الــتــوفــيــق فــي مــهــامــه ✨*'
        ].join('\n');
        await chat.sendMessage(banner, {
          mentions: mentionedToPromote
        });
      } catch (err) {
        console.error('خطأ برفع أدمن:', err.message);
        await message.reply('ما قدرت أرفعه أدمن، تأكد إني أدمن وعندي صلاحية 🙏');
      }
      return;
    }

    // -------- 5أ2) !انزل @شخص - ينزل عضو من الأدمن (اونر) بالجروب - أدمن بس --------
    if (body.startsWith('!انزل')) {
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
        await message.reply('لازم تخليني أدمن أول عشان أقدر أنزل حدا 🙏');
        return;
      }

      const mentionedToDemote = await message.getMentions();
      if (mentionedToDemote.length === 0) {
        await message.reply('لازم تعمل منشن للعضو اللي بدك تنزله من الأدمن 📌 مثال: !انزل @فلان');
        return;
      }

      try {
        const idsToDemote = mentionedToDemote.map((c) => c.id._serialized);
        await groupChat.demoteParticipants(idsToDemote);
        const demotedLine = mentionedToDemote.map((c) => `@${c.number}`).join('، ');
        const banner = [
          '╭━━━ ✦ 『 𝘼𝘿𝙈𝙄𝙉 𝙍𝙀𝙈𝙊𝙑𝙀𝘿 』 ✦ ━━━╮',
          '┃ *⚠️ تــم إزالــة مــشــرف مــن الــمــجــمــوعــة*',
          '┣━━━━━━━━━━━━━━━━━━┫',
          `┃ *👤 الــعــضــو :* ${demotedLine}`,
          '┃*🛡️ الــرتــبــة الــســابــقــة : مــشــرف*',
          `┃ *⏰ الــوقــت :* ${formatTripoliTime()}`,
          '╰━━━━━━━━━━━━━━━━━━╯',
          '',
          '*✨ شــكــراً لــه عــلــى مــجــهــوداتــه ✨*'
        ].join('\n');
        await chat.sendMessage(banner, {
          mentions: mentionedToDemote
        });
      } catch (err) {
        console.error('خطأ بتنزيل أدمن:', err.message);
        await message.reply('ما قدرت أنزله من الأدمن، تأكد إني أدمن وعندي صلاحية 🙏');
      }
      return;
    }

    // -------- 5ب0) !منشن [رسالة] - يمنشن كل أعضاء الجروب (أدمن بس) --------
    if (body.startsWith('!منشن')) {
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

      try {
        const extraText = body.replace('!منشن', '').trim();
        const admins = groupChat.participants.filter((p) => p.isAdmin);
        const members = groupChat.participants.filter((p) => !p.isAdmin);
        const mentionIds = groupChat.participants.map((p) => p.id._serialized);

        const adminLines = admins.map(
          (p) => `˼🌝˹ ┃${getCountryFlag(p.id.user)} @${p.id.user}`
        );
        const memberLines = members.map((p, idx) => {
          const isLastOverall = idx === members.length - 1; // آخر عضو بالقائمة كلها = قمر أسود
          const moon = isLastOverall ? '🌚' : '🌝';
          return `˼${moon}˹ ┃${getCountryFlag(p.id.user)} @${p.id.user}`;
        });

        const banner = [
          '❅ ━━━━ »✥«💀»✥« ━━━━ ❅',
          '*❍ 𝗧𝗢𝗝𝗜 𝗕𝗢𝗧*  😙╵𖣔╷↶',
          '❅ ━━━━ »✥«💀»✥« ━━━━ ❅',
          ...(extraText ? [extraText, '❅ ━━━━ »✥«💀»✥« ━━━━ ❅'] : []),
          `*المشرفون (${admins.length})*`,
          ...adminLines,
          '',
          `*الأعضاء (${members.length})*`,
          ...memberLines,
          '',
          '❅ ━━━━ »✥«🦆»✥« ━━━━ ❅',
          '˼⚡˹ ┃حسام لديكم لا خوف عليكم… 🦆',
          '˼🖤˹ ┃لا مكان هروب للاوغاد🖤',
          '˼☠️˹ ┃الفاتح دم من دماء الرجال☠️',
          '❅ ━━━━ »✥«🦆»✥« ━━━━ ❅'
        ].join('\n');
        await groupChat.sendMessage(banner, { mentions: mentionIds });
      } catch (err) {
        console.error('خطأ بأمر المنشن الجماعي:', err.message);
        await message.reply('ما قدرت أعمل المنشن الجماعي هلق، جرب بعد شوي 😅');
      }
      return;
    }

    // -------- 5ب0ب) !تغيير_صورة (مع إرفاق صورة، أو رد Reply على صورة) - يغير صورة بروفايل الجروب (أدمن بس) --------
    if (body.startsWith('!تغيير_صورة')) {
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
        await message.reply('لازم تخليني أدمن أول عشان أقدر أغيّر صورة الجروب 🙏');
        return;
      }

      try {
        let media = null;
        if (message.hasMedia) {
          media = await message.downloadMedia();
        } else if (message.hasQuotedMsg) {
          const quotedMsg = await message.getQuotedMessage();
          if (quotedMsg && quotedMsg.hasMedia) {
            media = await quotedMsg.downloadMedia();
          }
        }

        if (!media || !media.data) {
          await message.reply('لازم ترفق صورة مع الأمر، أو ترد (Reply) على صورة بـ !تغيير_صورة 📸');
          return;
        }

        const imageMedia = new MessageMedia(media.mimetype, media.data);
        await groupChat.setPicture(imageMedia);
        await message.reply('✅ تم تغيير صورة الجروب بنجاح');
      } catch (err) {
        console.error('خطأ بتغيير صورة الجروب:', err.message);
        await message.reply('ما قدرت أغيّر صورة الجروب، تأكد إني أدمن وإن الصورة صالحة 🙏');
      }
      return;
    }

    // -------- 5ب) !تحذير @شخص - يعرض عدد تحذيرات الشخص (أو تحذيراتك لو ما فيه منشن) --------
    if (body.startsWith('!تحذير') && !body.startsWith('!تحذيرات')) {
      if (!chat.isGroup) {
        await message.reply('هاد الأمر يشتغل بالجروبات بس 🙅');
        return;
      }
      const chatId = chat.id._serialized;
      const mentioned = await message.getMentions();
      let targetContact;
      let targetId;

      if (mentioned && mentioned.length > 0) {
        targetContact = mentioned[0];
        targetId = getCanonicalContactId(targetContact);
      } else {
        targetContact = await message.getContact();
        targetId = getCanonicalContactId(targetContact);
      }

      const count = getWarningCount(targetId, chatId);
      await chat.sendMessage(
        warningCountBanner(`@${targetContact.number}`, count, MAX_WARNINGS),
        { mentions: [targetContact] }
      );
      return;
    }

    // -------- 5ج) !ازالة_تحذير @شخص - يصفّر تحذيرات الشخص (أدمن بس) --------
    if (body.startsWith('!ازالة_تحذير')) {
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

      const mentioned = await message.getMentions();
      if (!mentioned || mentioned.length === 0) {
        await message.reply('لازم تعمل منشن للشخص اللي بدك تشيل تحذيراته 📌 مثال: !ازالة_تحذير @فلان');
        return;
      }

      const target = mentioned[0];
      const chatId = chat.id._serialized;
      resetWarnings(getCanonicalContactId(target), chatId);
      await chat.sendMessage(
        warningsResetBanner(`@${target.number}`),
        { mentions: [target] }
      );
      return;
    }

    // -------- 5د) !مخالفة / !مخالفه @شخص [سبب] - تحذير يدوي من الأدمن (تحذير واحد بس بكل استخدام) --------
    // بالجروب: بيطلع بانر فيه بس العدد (زي بانر التحذير التلقائي بالظبط)
    // بالخاص: بيوصل العضو بانر فيه سبب التحذير + اسمه بالضبط
    // لو وصل للحد الأقصى بالتحذيرات: طرد تلقائي زي باقي الكود
    if (body.startsWith('!مخالفة') || body.startsWith('!مخالفه')) {
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

      const mentioned = await message.getMentions();
      if (!mentioned || mentioned.length === 0) {
        await message.reply('لازم تعمل منشن للعضو اللي بدك تحذّره 📌 مثال: !مخالفة @فلان سبب التحذير');
        return;
      }
      const target = mentioned[0];

      // نستخرج السبب: نشيل اسم الأمر ونشيل رقم المنشن من النص
      const reason = body
        .replace(/^!مخالفة|^!مخالفه/, '')
        .replace(/@\d+/g, '')
        .trim();

      // لو ما كتبش سبب، منستخدم نص افتراضي بدل ما نوقف الأمر
      const finalReason = reason.length === 0 ? 'مخالفة لقوانين الجروب' : reason;

      const chatId = chat.id._serialized;
      const targetId = getCanonicalContactId(target);
      const newCount = addWarning(targetId, chatId);

      // نبعت بالخاص للعضو نفسه: السبب + اسمه بالضبط
      try {
        await client.sendMessage(targetId, violationDmBanner(finalReason, `@${target.number}`, newCount, MAX_WARNINGS));
      } catch (dmErr) {
        console.error('ما قدرت أبعت رسالة خاص للعضو المخالف:', dmErr.message);
      }

      if (newCount >= MAX_WARNINGS) {
        resetWarnings(targetId, chatId);
        try {
          const botParticipant = groupChat.participants.find(
            (p) => p.id._serialized === client.info.wid._serialized
          );
          if (botParticipant && botParticipant.isAdmin) {
            await groupChat.removeParticipants([targetId]);
            await chat.sendMessage(
              finalWarningKickBanner(`@${target.number}`, `@${sender.number}`),
              { mentions: [target, sender] }
            );
          } else {
            await chat.sendMessage(
              `@${target.number} وصل ${MAX_WARNINGS} تحذيرات وكان لازم يتطرد، بس أنا مش أدمن هنا، خلوني أدمن 🙏`,
              { mentions: [target] }
            );
          }
        } catch (kickErr) {
          console.error('خطأ بطرد العضو بعد وصوله للحد الأقصى من المخالفات:', kickErr.message);
        }
      } else {
        await chat.sendMessage(
          newWarningBanner(`@${target.number}`, newCount, MAX_WARNINGS),
          { mentions: [target] }
        );
      }
      return;
    }

    // -------- 6ب) !اوامر - يبعت نص القائمة (الأدمن يشوف قسم "إدارة" زيادة، العضو العادي ما يشوفهوش) --------
    if (body === '!اوامر') {
      let isSenderAdmin = false;
      if (chat.isGroup) {
        const sender = await message.getContact();
        const participant = chat.participants.find(
          (p) => p.id._serialized === sender.id._serialized
        );
        isSenderAdmin = !!(participant && participant.isAdmin);
      }

      const header = `╭━━✦ 𝙃𝙐𝙎𝘼𝘼𝙈 𝘽𝙊𝙏 ✦━━╮
🤖 الاســم: 𝗧𝗢𝗝𝗜 𝗕𝗢𝗧 𖤍
🔥 الإصــدار: 1.0
⚡ الــحــالــة: يـعـمـل
👨‍💻 الــمــطــور: 𝗛𝗢𝗦𝗦𝗔𝗠 𖤍
╰━━━━━━━━━━━━━━╯

🌐 الأوامــر الــعــامــة
🔹 !مــراد [سؤال] ↜ اسأل مـراد
🔹 !ســعاد [سؤال] ↜ اسأل سـعاد
🔹 !صــوت [نص] ↜ تحويل النص لصوت
🔹 !بــروفــايــل [@] ↜ صورة العضو
🔹 !رابــط ↜ رابط الجروب
🔹 !اوامــر ↜ قائمة الأوامر

━━━━━━━━━━━━

🎮 أوامــر الــتــســلــيــة
🔸 !تــحــدي ↜ سؤال تريڤيا
🔸 !ديــن ↜ سؤال ديني
🔸 !مـن_فـيـنـا ↜ اختيار عشوائي مرح

━━━━━━━━━━━━

🕌 أوقـات الـصـلاة (بالخاص بس)
🔹 !صلاة ↜ أوقات اليوم حسب دولتك
🔹 !تفعيل_تنبيه_الصلاة ↜ تنبيه تلقائي وقت كل أذان
🔹 !ايقاف_تنبيه_الصلاة ↜ إيقاف التنبيه`;

      const adminSection = `

━━━━━━━━━━━━

👑 أوامــر الــإدارة
🔹 !قــفــل / !فــتــح ↜ قفل/فتح الدردشة
🔹 !فتـح رابـط / !قفل رابط ↜ منع/سماح الروابط
🔹 !بــانــد @ ↜ حظر عضو
🔹 !اصعـد / !انزل @ ↜ إدارة الرتب
🔹 !تــوقـف / !تشغيل ↜ تشغيل وإيقاف مراد
🔹 !ازالـة_تحـذيـر @ ↜ حذف تحذير
🔹 !مخالفة @ [السبب] ↜ إعطاء تحذير يدوي
🔹 !منشن [رسالة] ↜ منشن جماعي لكل الأعضاء
🔹 !تغيير_صورة ↜ تغيير صورة الجروب`;

      const footer = `

━━━━━━━━━━━━

🚫 نــظــام الــتــحــذيــرات
🔸 !تحـذيـر ↜ عدد تحذيراتك

━━━━━━━━━━━━

💍 نــظــام الــعــلاقــات
💗 !زواج @ [المهر] ↜ طلب زواج
💔 !طـلاق @ ↜ إنهاء الزواج

━━━━━━━━━━━━

> *ᴘᴏᴡᴇʀᴇᴅ:* *Naruto Bot*`;

      const commandsList = isSenderAdmin
        ? header + adminSection + footer
        : header + footer;

      try {
        const gifBuffer = await getMenuGifMp4Buffer();
        const media = new MessageMedia('video/mp4', gifBuffer.toString('base64'));
        await chat.sendMessage(media, { caption: commandsList, sendVideoAsGif: true });
      } catch (imgErr) {
        console.error('فشل تجهيز جيف القائمة:', imgErr.message);
        await message.reply(commandsList);
      }
      return;
    }

    // -------- 6ج) !بروفايل @شخص - يبعت صورة بروفايل الشخص المنشن --------
    if (body.startsWith('!بروفايل')) {
      const mentioned = await message.getMentions();
      // لو ما فيه منشن، بيشتغل عليك انت لحالك (تماماً زي !xp)
      const hasMention = mentioned && mentioned.length > 0;
      const target = hasMention ? mentioned[0] : await message.getContact();
      const picBuffer = await getProfilePicBuffer(target);
      if (!picBuffer) {
        await message.reply('هاد ماله صورة بروفايل ظاهرة، أو خصوصيته ما بتسمح 🚫');
        return;
      }
      const media = new MessageMedia('image/jpeg', picBuffer.toString('base64'));
      const targetTag = target.number ? `@${target.number}` : (target.pushname || 'عضو');
      const caption = [
        '╭━━━◈ 🖤 𝙋𝙍𝙊𝙁𝙄𝙇𝙀 ◈━━━╮',
        '┃ ✦ تــم اســتــخــراج الــبــروفــايــل',
        '┃',
        `┃ *👤 الـمـسـتـخـدم :* ${targetTag}`,
        '┃ *📸 الـصـورة : مـتـاحـة*',
        '┃ *⚡ الـحـالـة : تـم الـجـلـب*',
        '╰━━━━━━━━━━━━━━╯',
        '',
        '> *ᴘᴏᴡᴇʀᴇᴅ:*⚡ 𝗧𝗢𝗝𝗜 𝗕𝗢𝗧 𖤍*'
      ].join('\n');
      await chat.sendMessage(media, { caption, mentions: [target] });
      return;
    }

    // -------- 6ج3) !تحدي - يطرح سؤال تريفيا عشوائي، أول واحد يجاوب صح ياخد XP إضافي --------
    if (body.startsWith('!تحدي')) {
      if (!chat.isGroup) {
        await message.reply('أمر !تحدي يشتغل بس بالجروبات 🎯');
        return;
      }
      if (pendingChallenges.has(chat.id._serialized)) {
        await message.reply('فيه تحدي شغال هلق، جاوب عليه الأول 👀');
        return;
      }

      const picked = CHALLENGE_QUESTIONS[Math.floor(Math.random() * CHALLENGE_QUESTIONS.length)];
      const chatId = chat.id._serialized;

      const timer = setTimeout(async () => {
        if (pendingChallenges.get(chatId)?.answer === picked.answer) {
          pendingChallenges.delete(chatId);
          try {
            await chat.sendMessage(challengeTimeoutBanner(picked.answer));
          } catch (timeoutErr) {
            console.error('خطأ بإرسال بانر انتهاء التحدي:', timeoutErr.message);
          }
        }
      }, CHALLENGE_TIMEOUT_MS);

      pendingChallenges.set(chatId, { question: picked.question, answer: picked.answer, askedBy: authorId, timer });
      await chat.sendMessage(challengeBanner(picked.question));
      return;
    }

    // -------- 6ج3ب) !دين - يطرح سؤال ديني عشوائي من dean.json، أول واحد يجاوب صح ياخد XP إضافي --------
    if (body.startsWith('!دين')) {
      if (DEAN_QUESTIONS.length === 0) {
        await message.reply('ملف الأسئلة الدينية (dean.json) ما تحمّلش صح، تأكد إنه موجود بنفس مجلد البوت 😅');
        return;
      }
      if (!chat.isGroup) {
        await message.reply('أمر !دين يشتغل بس بالجروبات 🕌');
        return;
      }
      if (pendingDeanQuestions.has(chat.id._serialized)) {
        await message.reply('فيه سؤال ديني شغال هلق، جاوب عليه الأول 👀');
        return;
      }

      const pickedDean = DEAN_QUESTIONS[Math.floor(Math.random() * DEAN_QUESTIONS.length)];
      const deanChatId = chat.id._serialized;

      const deanTimer = setTimeout(async () => {
        if (pendingDeanQuestions.get(deanChatId)?.answer === pickedDean.response) {
          pendingDeanQuestions.delete(deanChatId);
          try {
            await chat.sendMessage(deanTimeoutBanner(pickedDean.response));
          } catch (timeoutErr) {
            console.error('خطأ بإرسال بانر انتهاء السؤال الديني:', timeoutErr.message);
          }
        }
      }, DEAN_TIMEOUT_MS);

      pendingDeanQuestions.set(deanChatId, {
        question: pickedDean.question,
        answer: pickedDean.response,
        askedBy: authorId,
        timer: deanTimer
      });
      await chat.sendMessage(deanBanner(pickedDean.question));
      return;
    }

    // -------- 6ج4) !من_فينا [سؤال اختياري] - يختار عضو عشوائي من الجروب كإجابة مرحة --------
    if (body.startsWith('!من_فينا')) {
      if (!chat.isGroup) {
        await message.reply('أمر !من_فينا يشتغل بس بالجروبات 🎲');
        return;
      }

      const participants = chat.participants.filter(
        (p) => p.id._serialized !== client.info.wid._serialized
      );
      if (participants.length === 0) {
        await message.reply('ما لقيت أعضاء بالجروب أختار منهم 😅');
        return;
      }

      const chosenParticipant = participants[Math.floor(Math.random() * participants.length)];
      const chosenContact = await client.getContactById(chosenParticipant.id._serialized);
      const question = MIN_FIINA_QUESTIONS[Math.floor(Math.random() * MIN_FIINA_QUESTIONS.length)];

      await chat.sendMessage(
        minFiinaBanner(question, `@${chosenContact.number}`),
        { mentions: [chosenContact] }
      );
      return;
    }

    // -------- 6ج5) !ستيكر - تم حذفه بناءً على طلب المستخدم --------
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
      const husbandId = getCanonicalContactId(husband);
      const wifeId = getCanonicalContactId(wife);
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
      const requestKey = `${chatId}_${getCanonicalContactId(authorContact)}`;
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
      const senderId = getCanonicalContactId(sender);
      const targetId = getCanonicalContactId(target);

      const marriages = loadMarriages();
      // الحالة 1: الزوج يطلق زوجته
      let marriage = marriages.find(
        (m) => m.husbandId === senderId && m.wifeId === targetId && m.chatId === chatId && m.status === 'قائم'
      );

      if (marriage) {
        marriage.status = 'منتهي';
        saveMarriages(marriages);
        const banner = [
          '╔════════════════════════════╗',
          '║        💔    طـلاق 💔          ║',
          '╠════════════════════════════╣',
          `║  👨‍💼 *الــزوج:* @${sender.number}`,
          `║  👰‍♀️ *الــزوجــة:* @${target.number}`,
          '║  💔 *الــحــالــة:* مـطـلـق',
          '╚════════════════════════════╝',
          '',
          '😔 *نـتـمـنـى لـهـمـا كـل الـخـيـر* 😔',
          '',
          '*ربـي يـعـوضـهـمـا خـيـر ويـكـتـب لـهـمـا الـسـعـادة*'
        ].join('\n');
        await chat.sendMessage(banner, { mentions: [sender, target] });
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

    // -------- 6) !مراد - يرد على السؤال مع مراعاة سياق المحادثة السابقة --------
    if (body.startsWith('!مراد')) {
      if (!aiEnabled) {
        await message.reply(personaOfflineMessage('murad'));
        return;
      }
      const question = body.replace('!مراد', '').trim();
      const prompt = question.length > 0 ? question : 'سلم علينا يا مراد';
      const history = PERSONAS.murad.history.get(convoKey) || [];
      const reply = await askAI(prompt, history, 'murad');
      pushToHistory(PERSONAS.murad.history, convoKey, 'user', prompt);
      pushToHistory(PERSONAS.murad.history, convoKey, 'assistant', reply);
      const sentMsg = await message.reply(reply);
      rememberSentMessage(sentMsg, 'murad');
      return;
    }

    if (body.startsWith('!سعاد')) {
      if (!aiEnabled) {
        await message.reply(personaOfflineMessage('souad'));
        return;
      }
      const question = body.replace('!سعاد', '').trim();
      const prompt = question.length > 0 ? question : 'سلمي علينا يا سعاد';
      const history = PERSONAS.souad.history.get(convoKey) || [];
      const reply = await askAI(prompt, history, 'souad');
      pushToHistory(PERSONAS.souad.history, convoKey, 'user', prompt);
      pushToHistory(PERSONAS.souad.history, convoKey, 'assistant', reply);
      const sentMsg = await message.reply(reply);
      rememberSentMessage(sentMsg, 'souad');
      return;
    }


    // -------- 7) رد (Reply) على رسالة من مراد أو نوفا = ترد عليك بنفس شخصيتها بدون أمر (رد نصي) --------
    // شرط مهم: لازم يكون رد على رسالة البوت (fromMe)، مش رد على عضو أو الأونر
    // وكمان لازم يكون فيه محتوى حقيقي (مش نقطة أو رمز فاضي) عشان الذكاء الصناعي ميتلخبطش
    // ده بيشتغل كل مرة تكون فيها Reply فعلي على رسالة البوت، عدد المرات مش مهم
    // لو كتب عادي من غير Reply، مش هيرد خالص مهما كان
    if (aiEnabled && message.hasQuotedMsg && body.length > 1 && !body.startsWith('!')) {
      const quotedMsg = await message.getQuotedMessage();
      if (quotedMsg && quotedMsg.fromMe) {
        const personaKey = getPersonaForQuotedMessage(quotedMsg);
        const persona = PERSONAS[personaKey];
        const history = persona.history.get(convoKey) || [];
        const reply = await askAI(body, history, personaKey);
        pushToHistory(persona.history, convoKey, 'user', body);
        pushToHistory(persona.history, convoKey, 'assistant', reply);
        const sentMsg = await message.reply(reply);
        rememberSentMessage(sentMsg, personaKey);
        return;
      }
    }

    // -------- 8) !صوت - يحول نص لرسالة صوتية بصوت الشخصية المناسبة (مراد أو نوفا) --------
    // استخدام 1: !صوت نص تبيه يتحول صوت (افتراضي بصوت مراد لو ما فيه رد على رسالة)
    // استخدام 2: رد (Reply) على رسالة من مراد أو نوفا بـ "!صوت" (مع نص أو من غيره)، يحولها بنفس صوت صاحبتها
    // -------- 8ب) أوقات الصلاة (ليبيا/مصر/الجزائر/المغرب/تونس) - بالخاص بس --------
    // !صلاة: يرجع أوقات اليوم حسب دولة العضو (مكتشفة تلقائياً من رقمه)
    // !تفعيل_تنبيه_الصلاة / !ايقاف_تنبيه_الصلاة: يشترك/يلغي اشتراك تنبيه تلقائي بالخاص وقت كل أذان
    if (body.startsWith('!صلاة')) {
      if (chat.isGroup) {
        await message.reply('هاد الأمر يشتغل بالخاص بس 🙏 (راسلني بالخاص واكتب !صلاة)');
        return;
      }
      const contact = await message.getContact();
      const countryKey = prayer.detectCountryFromContact(contact);
      if (!countryKey) {
        await message.reply(prayer.unsupportedCountryMessage());
        return;
      }
      const timings = await prayer.getTodayTimings(countryKey);
      if (!timings) {
        await message.reply('ما قدرت أجيب أوقات الصلاة هلق، جرب بعد شوي 😅');
        return;
      }
      await message.reply(prayer.formatPrayerTimesMessage(countryKey, timings));
      return;
    }

    if (body.startsWith('!تفعيل_تنبيه_الصلاة')) {
      if (chat.isGroup) {
        await message.reply('هاد الأمر يشتغل بالخاص بس 🙏 (راسلني بالخاص)');
        return;
      }
      const contact = await message.getContact();
      const countryKey = prayer.detectCountryFromContact(contact);
      if (!countryKey) {
        await message.reply(prayer.unsupportedCountryMessage());
        return;
      }
      prayer.subscribeUser(PERSIST_DIR, message.from, countryKey);
      await message.reply(prayer.subscribedBanner(prayer.COUNTRIES[countryKey].name));
      return;
    }

    if (body.startsWith('!ايقاف_تنبيه_الصلاة')) {
      if (chat.isGroup) {
        await message.reply('هاد الأمر يشتغل بالخاص بس 🙏 (راسلني بالخاص)');
        return;
      }
      prayer.unsubscribeUser(PERSIST_DIR, message.from);
      await message.reply(prayer.unsubscribedBanner());
      return;
    }

    if (body.startsWith('!صوت')) {
      let textToSpeak = body.replace('!صوت', '').trim();
      let personaKeyForVoice = DEFAULT_PERSONA_KEY;

      if (message.hasQuotedMsg) {
        const quotedMsg = await message.getQuotedMessage();
        if (quotedMsg && quotedMsg.fromMe) {
          personaKeyForVoice = getPersonaForQuotedMessage(quotedMsg);
          if (textToSpeak.length === 0 && quotedMsg.body) {
            textToSpeak = quotedMsg.body;
          }
        }
      }

      if (!aiEnabled) {
        await message.reply(personaOfflineMessage(personaKeyForVoice));
        return;
      }

      if (textToSpeak.length === 0) {
        await message.reply('اكتب النص اللي بدك تحوله صوت، أو رد (Reply) على رسالة من مراد بـ !صوت 🎙️');
        return;
      }

      try {
        const persona = PERSONAS[personaKeyForVoice];
        const voiceBuffer = await textToVoiceBuffer(textToSpeak, GROQ_API_KEY, persona.voice);
        const media = new MessageMedia('audio/ogg; codecs=opus', voiceBuffer.toString('base64'));
        const sentMsg = await chat.sendMessage(media, { sendAudioAsVoice: true });
        rememberSentMessage(sentMsg, personaKeyForVoice);
      } catch (err) {
        console.error('خطأ بتحويل النص لصوت:', err.message);
        // مؤقتاً: نورّي تفاصيل الخطأ بالرد نفسه عشان نقدر نشخص المشكلة بدون الرجوع للوق
        await message.reply(`ما قدرت أسوي الصوت هلق 😅\n🔧 تفاصيل الخطأ: ${err.message}`);
      }
      return;
    }

    // -------- 9) رسالة صوتية (Reply على رسالة البوت) = يفرغها، يفهمها، ويرد بصوت بنفس الشخصية اللي ردّيت عليها --------
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
          const transcribedText = await transcribeVoiceBuffer(audioBuffer, media.mimetype, GROQ_API_KEY);

          if (!transcribedText) {
            await message.reply('ما فهمت شي من الصوت، جرب تحكي أوضح 🎙️');
            return;
          }

          const personaKey = getPersonaForQuotedMessage(quotedMsg);
          const persona = PERSONAS[personaKey];
          const history = persona.history.get(convoKey) || [];
          const aiReply = await askAI(transcribedText, history, personaKey);
          pushToHistory(persona.history, convoKey, 'user', transcribedText);
          pushToHistory(persona.history, convoKey, 'assistant', aiReply);

          const voiceBuffer = await textToVoiceBuffer(aiReply, GROQ_API_KEY, persona.voice);
          const voiceMedia = new MessageMedia('audio/ogg; codecs=opus', voiceBuffer.toString('base64'));
          const sentMsg = await chat.sendMessage(voiceMedia, { sendAudioAsVoice: true });
          rememberSentMessage(sentMsg, personaKey);
        } catch (err) {
          console.error('خطأ بمعالجة الرسالة الصوتية:', err.message);
          await message.reply('صار في مشكلة وأنا نسمعك، جرب بعد شوي 😅');
        }
        return;
      }
    }

    // -------- 10) رسالة قصيرة (3 كلمات أو أقل) فيها "بروفايل" بس مش بصيغة الأمر الصح --------
    // مثال: "بروفايل" أو "بروفايلك" لحالها من غير ! → منعتبرها محاولة أمر غلط
    // الجمل الطويلة العادية (أكتر من 3 كلمات) ما بتتأثرش حتى لو فيها كلمة بروفايل
    if (!body.startsWith('!') && body.length > 0) {
      const words = body.split(/\s+/).filter(Boolean);
      if (words.length > 0 && words.length <= 3 && /بروفايل/i.test(body)) {
        await message.reply(wrongCommandBanner());
        return;
      }
    }

    // -------- 11) كاتش-أول: أي أمر يبدأ بـ ! وما تطابقش مع ولا أمر معروف فوق --------
    if (body.startsWith('!')) {
      await message.reply(wrongCommandBanner());
      return;
    }
  } catch (err) {
    // نطبعه بسطرين منفصلين (عربي ثم إنجليزي) بدل خلطهم بسطر وحد، عشان نتفادى
    // مشكلة قص النص بصريًا لما يترتب فيها RTL وLTR مع بعض على شاشات ضيقة
    console.error('خطأ بمعالجة الرسالة:');
    console.error('MSG:', err?.message || '(no message)');
    console.error('NAME:', err?.name || '(no name)');
    // مهم: نطبع الـ stack كامل كمان - لأنه أحياناً رسالة الخطأ نفسها بتطلع مقصوصة لحرف واحد
    // بس (زي "r")، بسبب تصغير كود Puppeteer الداخلي، وبدون الـ stack ما منقدر نشخص أي شي
    if (err?.stack) console.error('STACK:', err.stack);

    // ⚠️ لو رسالة الخطأ قصيرة جداً (حرف أو حرفين، زي "r")، هذا نفسه مؤشر معروف إنه خطأ
    // بروتوكول/تايم-اوت مصغّر جاي من كروميوم/Puppeteer (شفنا هالحالة بالظبط باللوق)، فمنعامله
    // كأنه بروتوكول تايم-اوت حتى لو ما فيهوش الكلمات المعتادة زي "callFunctionOn"، عشان
    // الحارس التلقائي يقدر يكتشفه ويتصرف بدل ما يفوته
    const looksLikeMinifiedProtocolError = err?.message && err.message.length <= 3;
    const looksLikeKnownProtocolText = err?.message && (
      err.message.includes('callFunctionOn') ||
      err.message.includes('protocolTimeout') ||
      err.message.includes('Timed out')
    );
    if (looksLikeMinifiedProtocolError || looksLikeKnownProtocolText) {
      console.warn('🩺 اعتبرت هذا الخطأ من نوع بروتوكول/تايم-اوت (مصغّر أو معروف)، هبلّغ الحارس التلقائي.');
      reportProtocolTimeout();
    }
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
// قبل ما نشغّل العميل، منحاول نجيب "النسخة الحالية" لواتساب ويب تلقائيًا من نفس مصدر
// المكتبة الرسمي (ملف versions.json بمستودع wppconnect-team/wa-version) بدل ما نعتمد
// بس على الرابط المثبت يدويًا فوق بـ webVersionCache - لأنه هذا الملف بيتغيّر كل كام ساعة
// وأي رابط نثبته هيتقادم عاجلاً أم آجلاً (وهذا بالضبط اللي صار وسبب مشكلة "r" الأولى).
// لو الجلب فشل لأي سبب (مثلاً GitHub مش متاح وقت الإقلاع)، منرجع تلقائيًا للرابط
// المثبت يدويًا جوه إعداد webVersionCache، فالبوت يضل يقدر يشتغل حتى لو الجلب التلقائي فشل.
async function startBot() {
  try {
    const { data } = await axios.get(
      'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json',
      { timeout: 8000 }
    );
    const latestVersion = data?.currentVersion;
    if (latestVersion) {
      client.options.webVersionCache = {
        type: 'remote',
        remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${latestVersion}.html`
      };
      console.log(`✅ نسخة واتساب ويب (جلب تلقائي عند الإقلاع): ${latestVersion}`);
    } else {
      console.warn('⚠️ ملف versions.json ما فيهوش currentVersion، هستخدم الرابط المثبت يدويًا بالكود.');
    }
  } catch (err) {
    console.warn(`⚠️ ما قدرت أجيب أحدث نسخة واتساب ويب تلقائيًا (${err.message})، هستخدم الرابط المثبت يدويًا بالكود.`);
  }
  client.initialize();
}

startBot();
