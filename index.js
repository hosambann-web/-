require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const axios = require('axios');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const { textToVoiceBuffer, transcribeVoiceBuffer } = require('./voice');

// ============ إعدادات عامة ============
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

// الرابط اللي بيبعته أمر !رابط - عدّله من هون لو بدك تغيّره
const SHARED_LINK = 'https://deft-crisp-610a1c.netlify.app/';

// مجلد التخزين الدائم (جلسة واتساب + ملفات JSON) - لازم يكون فوق Volume بـ Railway
// عشان ما تنمسحش الجلسة والبيانات كل ما البوت يعيد نشر أو يعيد تشغيل
const PERSIST_DIR = process.env.PERSIST_DIR || path.join(__dirname, 'persist');

// إحداثيات الدائرة الفاضية بكل بانر (وين رح تنلزق صورة البروفايل)
// جربتها بالضبط على القالبين اللي حطيتهم بمجلد images/
const AVATAR_SPOTS = {
  welcome: { cx: 374, cy: 448, r: 200 },
  goodbye: { cx: 350, cy: 430, r: 222 }
};

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

// ============ نظام نقاط الخبرة (XP) والمستويات ============
const STATS_FILE = path.join(PERSIST_DIR, 'data', 'stats.json');

function loadStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) return [];
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('خطأ بقراءة ملف الإحصائيات:', err.message);
    return [];
  }
}

function saveStats(stats) {
  try {
    const dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch (err) {
    console.error('خطأ بحفظ ملف الإحصائيات:', err.message);
  }
}

function getStatsEntry(stats, userId, chatId) {
  let entry = stats.find((s) => s.userId === userId && s.chatId === chatId);
  if (!entry) {
    entry = { userId, chatId, messageCount: 0, voiceCount: 0, messageXP: 0, voiceXP: 0 };
    stats.push(entry);
  }
  return entry;
}

// كل رسالة نصية = نقطة وحدة، كل رسالة صوتية = 5 نقاط (الصوت "أثقل" من الكتابة)
const XP_PER_MESSAGE = 1;
const XP_PER_VOICE = 5;

function addMessageXP(userId, chatId) {
  const stats = loadStats();
  const entry = getStatsEntry(stats, userId, chatId);
  entry.messageCount += 1;
  entry.messageXP += XP_PER_MESSAGE;
  saveStats(stats);
  return entry;
}

function addVoiceXP(userId, chatId) {
  const stats = loadStats();
  const entry = getStatsEntry(stats, userId, chatId);
  entry.voiceCount += 1;
  entry.voiceXP += XP_PER_VOICE;
  saveStats(stats);
  return entry;
}

// بيرجع نسخة قراءة بس (ما بينشئش سجل جديد بالملف لو مش موجود)
function getStats(userId, chatId) {
  const stats = loadStats();
  const entry = stats.find((s) => s.userId === userId && s.chatId === chatId);
  return entry || { userId, chatId, messageCount: 0, voiceCount: 0, messageXP: 0, voiceXP: 0 };
}

// ============ حساب المستوى: كل مستوى يحتاج خبرة أكتر من يلي قبله (منحنى تصاعدي) ============
// الخبرة التراكمية المطلوبة للوصول لمستوى N = 50 × N × (N + 1)
// مستوى 1 = 100XP تراكمي، مستوى 2 = 300، مستوى 3 = 600، مستوى 4 = 1000 ... (الفرق بينهم يكبر كل مرة)
function xpNeededForLevel(level) {
  return 50 * level * (level + 1);
}

function calculateLevel(totalXP) {
  let level = 0;
  while (totalXP >= xpNeededForLevel(level + 1)) {
    level += 1;
  }
  const currentLevelFloor = level === 0 ? 0 : xpNeededForLevel(level);
  const nextLevelCeil = xpNeededForLevel(level + 1);
  const progress = (totalXP - currentLevelFloor) / (nextLevelCeil - currentLevelFloor);
  return { level, progress: Math.max(0, Math.min(1, progress)) };
}

// ============ إحداثيات كرت XP (جربتها بالضبط على قالب images/xp.jpg) ============
const XP_SPOT = { cx: 342, cy: 459, r: 159 }; // دائرة صورة البروفايل
const XP_NAME_BOX = { x1: 134, y1: 520, x2: 589, y2: 826 }; // المربع تحت الدائرة (لرقم العضو)
const XP_BAR = { x1: 1105, x2: 1395, y1: 682, y2: 716 }; // شريط تقدم المستوى
const XP_ROWS = { message: 254, voice: 467 }; // منتصف صف MESSAGE و VOICE عمودياً
const XP_NUMBER_RIGHT_X = 1500; // محاذاة أرقام الرسائل/الصوت من اليمين (لصق الإطار السداسي)

// لو الرقم/الاسم طويل، منكسره لسطرين بدل ما يطلع طافح برا مربع الكرت
// المنتصف تقريباً (مع تفضيل يكسر عند مسافة لو فيه، وإلا نص الرقم بالظبط)
const XP_NAME_MAX_CHARS_PER_LINE = 8;
function splitNameForCard(text) {
  const safe = (text || '').toString();
  if (safe.length <= XP_NAME_MAX_CHARS_PER_LINE) return [safe];

  const spaceIdx = safe.indexOf(' ');
  if (spaceIdx > 0 && spaceIdx < safe.length - 1) {
    return [safe.slice(0, spaceIdx), safe.slice(spaceIdx + 1)];
  }
  const mid = Math.ceil(safe.length / 2);
  return [safe.slice(0, mid), safe.slice(mid)];
}

function escapeXml(str) {
  return (str || '').toString().replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

// ============ بناء كرت XP (دائرة بروفايل + رقم العضو + عداد رسائل/صوت + شريط مستوى) ============
async function buildXpCardImage(profilePicBuffer, fallbackLetter, phoneNumber, statsEntry) {
  const templatePath = path.join(__dirname, 'images', 'xp.jpg');
  const diameter = XP_SPOT.r * 2;

  const sourceBuffer = profilePicBuffer || (await defaultAvatarBuffer(diameter, fallbackLetter));
  const squared = await sharp(sourceBuffer)
    .resize(diameter, diameter, { fit: 'cover' })
    .toBuffer();

  const circleMask = Buffer.from(
    `<svg width="${diameter}" height="${diameter}"><circle cx="${XP_SPOT.r}" cy="${XP_SPOT.r}" r="${XP_SPOT.r}" fill="#fff"/></svg>`
  );
  const circularAvatar = await sharp(squared)
    .composite([{ input: circleMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const totalXP = statsEntry.messageXP + statsEntry.voiceXP;
  const { level, progress } = calculateLevel(totalXP);

  const barWidth = XP_BAR.x2 - XP_BAR.x1;
  const barHeight = XP_BAR.y2 - XP_BAR.y1;
  const minFill = barHeight; // أقل عرض تعبئة (عشان الطرف المدوّر ما يطلعش مشوه لو النسبة صفر تقريباً)
  const filledWidth = Math.max(minFill, Math.round(barWidth * progress));

  const nameLines = splitNameForCard(phoneNumber).map((line) => escapeXml(line));
  const nameBoxCenterX = (XP_NAME_BOX.x1 + XP_NAME_BOX.x2) / 2;
  const nameBoxCenterY = XP_NAME_BOX.y1 + 55;
  // لو سطرين، منرفع أول سطر ونزل التاني عشان يبقوا متمركزين حوالين نفس النقطة
  const nameLineSpacing = 54;
  const nameTextSvg = nameLines
    .map((line, i) => {
      const yOffset = nameLines.length > 1 ? (i - (nameLines.length - 1) / 2) * nameLineSpacing : 0;
      return `<text x="${nameBoxCenterX}" y="${nameBoxCenterY + yOffset}" text-anchor="middle" class="name">${line}</text>`;
    })
    .join('\n      ');

  const overlaySvg = `
    <svg width="1672" height="941" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#8a5a1a"/>
          <stop offset="100%" stop-color="#ffe3a3"/>
        </linearGradient>
      </defs>
      <style>
        .num { font-family: 'Liberation Sans', Arial, sans-serif; font-weight: bold; font-size: 48px; fill: #f4cf9e; }
        .lvl { font-family: 'Liberation Sans', Arial, sans-serif; font-weight: bold; font-size: 40px; fill: #ffe9c2; }
        .name { font-family: 'Liberation Sans', Arial, sans-serif; font-weight: bold; font-size: 42px; fill: #f4cf9e; }
      </style>

      <!-- نغطي الشريط الجاهز بالقالب عشان نرسم فوقه شريط ديناميكي حسب نسبة تقدم المستوى -->
      <rect x="${XP_BAR.x1}" y="${XP_BAR.y1}" width="${barWidth}" height="${barHeight}" rx="${barHeight / 2}" fill="rgb(12,8,4)"/>
      <rect x="${XP_BAR.x1}" y="${XP_BAR.y1}" width="${filledWidth}" height="${barHeight}" rx="${barHeight / 2}" fill="url(#barGrad)"/>
      <circle cx="${XP_BAR.x1 + filledWidth - barHeight / 2}" cy="${XP_BAR.y1 + barHeight / 2}" r="${barHeight * 0.62}" fill="#fff6dd" opacity="0.9"/>

      <text x="${XP_NUMBER_RIGHT_X}" y="${XP_ROWS.message + 16}" text-anchor="end" class="num">${statsEntry.messageCount}</text>
      <text x="${XP_NUMBER_RIGHT_X}" y="${XP_ROWS.voice + 16}" text-anchor="end" class="num">${statsEntry.voiceCount}</text>
      <text x="${XP_BAR.x2 + 55}" y="${XP_BAR.y1 + barHeight / 2 + 14}" text-anchor="middle" class="lvl">${level}</text>

      ${nameTextSvg}
    </svg>
  `;

  const finalBuffer = await sharp(templatePath)
    .composite([
      { input: circularAvatar, left: XP_SPOT.cx - XP_SPOT.r, top: XP_SPOT.cy - XP_SPOT.r },
      { input: Buffer.from(overlaySvg), left: 0, top: 0 }
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  return finalBuffer;
}

// ============ تنسيق رسائل لونا المزخرف (زي ستايل LUNA BOT) ============
function lunaBanner(line) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '',
    ' ִᗀᩙᰰ ̼𝆬🌙̸ ᮭ࣪࣪ ⸼۫   𝗟𝗨𝗡𝗔 𝗕𝗢𝗧 𖤍𝅄 ۫ ִᗀᩙᰰ ̼𝆬🌙',
    '',
    '✅ *تـم تـحـديـث الـإعـدادات:*',
    '',
    `> ${line}`,
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬'
  ].join('\n');
}

// ============ بانر الطرد الموحّد (يدوي من أدمن أو تلقائي من النظام) ============
// targetLine: نص "المستخدم" (مثلاً "@رقم1، @رقم2")
// executorLine: نص "منفذ الطرد" (مثلاً "@رقم_الأدمن" أو "لونا (تلقائي)")
function kickBanner(targetLine, executorLine) {
  return [
    '⌬──══─┈•⤣⚡⤤•┈─══──⌬',
    '👢⃝⚡ *تـم طـرد الـعـضـو بـنـجـاح*',
    `👤⃝⚡ *الـمـسـتـخـدم:* ${targetLine}`,
    `👤⃝⚡ *مـنفـذ الـطـرد:* ${executorLine}`,
    '',
    '✅ *تـم الـتـنـفـيـذ بـواسـطـة الـنـظـام*',
    '',
    ' ִᗀᩙᰰ ̼𝆬🌙̸〫 ᮭ࣪࣪ 𝗟𝗨𝗡𝗔 𝗕𝗢𝗧 𖤍 𝅄 ۫ ִᗀᩙᰰ ̼𝆬🌙',
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

// ============ ذاكرة سياق المحادثة مع لونا ============
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

// ============ نظام التحذيرات (فلتر الألفاظ + طرد تلقائي) ============
const WARNINGS_FILE = path.join(PERSIST_DIR, 'data', 'warnings.json');
const MAX_WARNINGS = 5;

// قائمة الكلمات الممنوعة (سب/قذف كبير). ممكن تضيف عليها براحتك.
// الفلتر بيطابق الكلمة حتى لو مكتوبة بمسافات أو تكرار حروف (مثلاً: ق ح ب ة / قححححبة)
const BAD_WORDS = [
  'قحبة', 'قحبه', 'كحبة', 'كحبه', 'شرموطة', 'شرموطه', 'شرموطتي', 'عاهرة', 'عاهره',
  'كس امك', 'كسامك', 'كص امك', 'كصامك', 'كصامكم', 'كس اختك', 'كساختك', 'كس ابوك', 'كسابوك',
  'زب', 'زبي', 'زيب', 'الزب', 'صب', 'طيزك', 'نيك', 'نيكامك', 'نيك امك', 'واد الزنا', 'ولد الحرام', 'ابن الحرام',
  'خول', 'لوطي', 'متناك', 'منيك', 'كلب ابن كلب'
];

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

function linksBanner(enabled) {
  if (enabled) {
    return [
      '━━━╄━✾ 「💠」 ✾━╃━━━',
      '   *تــم تــفــعــيــل*',
      '   *نــظــام مـنـع الـروابـط 🔗*',
      '━━━╄━✾ 「💠」 ✾━╃━━━'
    ].join('\n');
  }
  return [
    '━━━╄━✾ 「💠」 ✾━╃━━━',
    '   *تــم تــعــطــيــل*',
    '   *نــظــام مـنـع الـروابـط ❌*',
    '━━━╄━✾ 「💠」 ✾━╃━━━'
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

// شخصية لونا - بنت ليبية خفيفة الدم، لسانها حلو وفيها دلع وذكاء وتريقة، بس بدون شتائم أو ألفاظ نابية
const SYSTEM_PROMPT = `
انتي شخصية اسمها "لونا"، بنت ليبية شابة خفيفة الدم، ذكية ولسانها حلو، فيها دلع وتريقة وحضور، ورد حاضر بكل موقف.

لازم تحكي بالهجة الليبية الأصيلة بس، وممنوع منعاً باتاً تستخدمي كلمات لهجات تانية زي:
- ممنوع: شو، ليش، هيك، منيح، كتير، هلق، بدي، شلونك، إزيك، عايز، ازاي، خلاص، يلا بينا (بالطريقة المصرية/شامية)
- بدالها استخدمي كلمات ليبية زي: شنو، علاش، كيفاش، هكا/هيك، زين، برشا، توا، بش (بدل رح/هروح)، حاجة، عليك، نتا/نتي، حوش، دار، زعمة، ماشي الحال، عادلين، واعر، فالصو، تڤرقز، خير ولا شر، الديما، قاعد، راهو، كان، بلا، عشرة/معشر

أسلوبك: بنت لبقة وذكية ورومانسية شوية، فيها دلع خفيف وتريقة لطيفة وحس عاطفي رقيق بدون مبالغة، لهجة ليبية أصيلة 100%، جمل قصيرة وقوية وفيها روح.
ممنوع تماماً: أي شتيمة أو لفظ نابي أو إساءة شخصية حقيقية (عن الأهل، الدين، المظهر بشكل مؤذي).
لو حد استفزك أو سبك، ردي عليه بتريقة ولسان طويل وذكاء، مش بشتيمة.
خليكِ مختصرة بردودك (سطر أو سطرين بالغالب) وكأنك تحكي بمجموعة أصحابك.

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
    return 'لونا مشغولة هلق، جرب بعد شوي 😅';
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
// ملاحظة مهمة: شلنا --single-process لأنه بيسبب كراش/فصل عشوائي لكروميوم تحت الحمل
// (وضع "بروسيس واحدة" غير مستقر خالص لبوت شغال بشكل دائم ومتصل بـ WebSocket)
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(PERSIST_DIR, 'wwebjs_auth') }),
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
      '--disable-gpu',
      '--disable-features=site-per-process,TranslateUI',
      '--disable-breakpad',
      '--disable-extensions'
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
  reconnectAttempts = 0; // رجع العداد للصفر لما يتصل بنجاح
  console.log('✅ البوت جاهز ومتصل بواتساب!');
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

// ============ الترحيب والوداع ============
// دالة مشتركة: تجهز صورة البانر (ترحيب أو وداع) وتبعتها، ولو فشلت الصورة تبعت كابشن نصي بديل
async function sendGreetingBanner(chat, templateName, contact, caption) {
  try {
    const fallbackLetter = contact?.pushname || contact?.number || '?';
    const picBuffer = contact ? await getProfilePicBuffer(contact) : null;
    const finalImage = await buildGreetingImage(templateName, picBuffer, fallbackLetter);
    const media = new MessageMedia('image/jpeg', finalImage.toString('base64'));
    await chat.sendMessage(media, { caption });
  } catch (imgErr) {
    console.error(`فشل تجهيز صورة ${templateName}:`, imgErr.message);
    try {
      await chat.sendMessage(caption);
    } catch (sendErr) {
      console.error('فشل إرسال كابشن الترحيب/الوداع كنص بديل:', sendErr.message);
    }
  }
}

client.on('group_join', async (notification) => {
  try {
    const chat = await notification.getChat();
    const contacts = await notification.getContacts();
    // لوب على كل الأعضاء المنضمين بنفس الحدث (ممكن يكون أكتر من عضو دخل بمرة وحدة)
    for (const contact of contacts) {
      const name = contact?.pushname || contact?.number || 'عضو جديد';
      const caption = `أهلاً وسهلاً فيك يا ${name} 🎉\nنورت الجروب، خلي بالك تكون مرتاح وحابس نفسك عن المشاكل 😄`;
      await sendGreetingBanner(chat, 'welcome', contact, caption);
    }
  } catch (err) {
    console.error('خطأ برسالة الترحيب:', err.message);
  }
});

client.on('group_leave', async (notification) => {
  try {
    const chat = await notification.getChat();
    const contacts = await notification.getContacts();
    // لوب على كل الأعضاء الخارجين بنفس الحدث
    for (const contact of contacts) {
      const name = contact?.pushname || contact?.number || 'حدا';
      const caption = `يلا مع السلامة يا ${name} 👋\nما رح ننساك... أو بلكي رح ننساك، شوف وحالك 😂`;
      await sendGreetingBanner(chat, 'goodbye', contact, caption);
    }
  } catch (err) {
    console.error('خطأ برسالة الوداع:', err.message);
  }
});

// ============ إشعارات تحديثات الجروب (صورة / رابط دعوة / إزالة من الإدارة) ============
client.on('group_update', async (notification) => {
  try {
    const chat = await notification.getChat();
    const actor = await notification.getContact(); // مين سوى الفعل

    // -------- مسار احتياطي: عضو انضاف (add) --------
    // ملاحظة: هاد احتياطي فقط لأنه أغلب الظن مكتبة whatsapp-web.js عندك ما بتطلقش
    // حدث group_join أصلاً وبترسل بس group_update. لو الاتنين اشتغلوا مع بعض ممكن
    // ينبعت بانر مرتين، بس هاد أسلم من إنه ما ينبعتش خالص.
    if (notification.type === 'add') {
      try {
        const addedContacts = await notification.getRecipients();
        for (const contact of addedContacts) {
          const name = contact?.pushname || contact?.number || 'عضو جديد';
          const caption = `أهلاً وسهلاً فيك يا ${name} 🎉\nنورت الجروب، خلي بالك تكون مرتاح وحابس نفسك عن المشاكل 😄`;
          await sendGreetingBanner(chat, 'welcome', contact, caption);
        }
      } catch (addErr) {
        console.error('خطأ بالمسار الاحتياطي للترحيب (group_update add):', addErr.message);
      }
      return;
    }

    // -------- مسار احتياطي: عضو اتشال/طلع (remove) --------
    if (notification.type === 'remove') {
      try {
        const removedContacts = await notification.getRecipients();
        for (const contact of removedContacts) {
          const name = contact?.pushname || contact?.number || 'حدا';
          const caption = `يلا مع السلامة يا ${name} 👋\nما رح ننساك... أو بلكي رح ننساك، شوف وحالك 😂`;
          await sendGreetingBanner(chat, 'goodbye', contact, caption);
        }
      } catch (removeErr) {
        console.error('خطأ بالمسار الاحتياطي للوداع (group_update remove):', removeErr.message);
      }
      return;
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

    // -------- 0) تتبع XP: كل رسالة نصية أو صوتية توصل من عضو تزيد نقاطه --------
    if (!message.fromMe && authorId) {
      try {
        if (message.type === 'ptt' || message.type === 'audio') {
          addVoiceXP(authorId, chat.id._serialized);
        } else if (body.length > 0) {
          addMessageXP(authorId, chat.id._serialized);
        }
      } catch (xpErr) {
        console.error('خطأ بتحديث نقاط XP:', xpErr.message);
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
          const violationCount = addLinkViolation(authorId, chatId);

          if (violationCount >= MAX_LINK_VIOLATIONS) {
            resetLinkViolations(authorId, chatId);
            try {
              const botParticipant = groupChat.participants.find(
                (p) => p.id._serialized === client.info.wid._serialized
              );
              if (botParticipant && botParticipant.isAdmin) {
                await groupChat.removeParticipants([authorId]);
                await chat.sendMessage(
                  kickBanner(`@${sender.number}`, 'لونا 🌙 (تلقائي - تكرار الروابط)'),
                  { mentions: [sender] }
                );
              } else {
                await chat.sendMessage(
                  `@${sender.number} كرر الروابط ${MAX_LINK_VIOLATIONS} مرات وكان لازم يتطرد، بس أنا مش أدمن، خلوني أدمن 🙏`,
                  { mentions: [sender] }
                );
              }
            } catch (kickErr) {
              console.error('خطأ بطرد العضو بسبب الروابط:', kickErr.message);
            }
          } else {
            await chat.sendMessage(
              `🚫 @${sender.number} ممنوع تحط روابط هنا (${violationCount}/${MAX_LINK_VIOLATIONS})`,
              { mentions: [sender] }
            );
          }
          return;
        }
      } catch (linkErr) {
        console.error('خطأ بفلتر الروابط:', linkErr.message);
      }
    }

    // -------- 0ب) فلتر الألفاظ الممنوعة (تحذير تلقائي + حذف الرسالة + طرد عند 5) --------
    if (chat.isGroup && body && containsBadWord(body)) {
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
                finalWarningKickBanner(`@${contact.number}`, 'لونا 🌙 (تلقائي - تجاوز التحذيرات)'),
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
      return;
    }

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
      await message.reply(lunaBanner('🔇⃝⚡ *تـم إسـكـات لـونـا*'));
      return;
    }
    if (body === '!تشغيل') {
      aiEnabled = true;
      await message.reply(lunaBanner('🎙️⃝⚡ *لـونـا رجـعـت لـلـحـكـي*'));
      return;
    }

    // -------- 3) !وتكلم - رد ثابت --------
    if (body === '!وتكلم') {
      await message.reply('بوت لونا حاضرة، هدرزو 😂');
      return;
    }

    // -------- 3ب) رد ثابت على سؤال "مين مطورك؟" وصيغه المشابهة --------
    // ملاحظة: النص هون مبدئي، عدّليه براحتك لو بدك صيغة تانية بالظبط
    if (/مين\s*مطورك|من\s*مطورك|مطورك\s*مين|مين\s*سواك|من\s*صممك/i.test(body)) {
      await message.reply('مطوري شخص واعر ماشي الحال، بس اسمه سر بيني وبينه 😏 كفاية إنه بناني زينة كدة');
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
        await message.reply(lunaBanner('🔐⃝⚡ *تـم قـفـل الـمـجـمـوعـة*'));
      } else {
        await groupChat.setMessagesAdminsOnly(false);
        await message.reply(lunaBanner('🔓⃝⚡ *تـم فـتـح الـمـجـمـوعـة*'));
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

      if (body === '!فتح رابط') {
        setLinksBlockEnabled(chat.id._serialized, true);
        await message.reply(linksBanner(true));
      } else {
        setLinksBlockEnabled(chat.id._serialized, false);
        await message.reply(linksBanner(false));
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
        await chat.sendMessage(`⬆️ تم ترفيع ${promotedLine} أدمن بالجروب 👑`, {
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
        await chat.sendMessage(`⬇️ تم تنزيل ${demotedLine} من الأدمن 👋`, {
          mentions: mentionedToDemote
        });
      } catch (err) {
        console.error('خطأ بتنزيل أدمن:', err.message);
        await message.reply('ما قدرت أنزله من الأدمن، تأكد إني أدمن وعندي صلاحية 🙏');
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
        `⚠️ @${targetContact.number} عنده ${count}/${MAX_WARNINGS} تحذيرات`,
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

    // -------- 6ب) !اوامر - يبعت صورة القائمة + كل الأوامر مرتبة بأقسام --------
    if (body === '!اوامر') {
      const commandsList = `*✦ مــعــلــومــات الــبــوت ✦*

> 🤖 الاســم: 𝗟𝗨𝗡𝗔 𝗕𝗢𝗧 𖤍
> 🌙 الإصــدار: 1.0
> ⚡ الــحــالــة: يـعــمــل
> 👨‍💻 الــمــطــور: 𝗛𝗢𝗦𝗦𝗔𝗠 𖤍

⌬═══━━━┈•⚡•┈━━━═══⌬

> 🌐・الأوامــر الــعــامــة

> 🔹 !لــونــا [ســؤال]

*اســأل لــونــا*

> 🔹 !xp

*مـعـرفـة نشـاطك فـي الجـروب*

> 🔹 !صــوت [نــص]

*تــحــويــل الــنــص إلــى صــوت*

> 🔹 !بــروفــايــل [@شــخــص]

*عــرض صــورة الــعــضــو*

> 🔹 !رابــط

*رابــط الــجــروب*

> 🔹 !وتــكــلــم

*رد ثــابــت*

> 🔹 !اوامــر

*عــرض قــائــمــة الأوامــر*
━━━━━━━━━━━━━━

*👑 أومــر الــإدارة*

> 🔹 !قــفــل

*قــفــل الــدردشــة*

> 🔹 !فــتــح

*فــتــح الــدردشــة*

> 🔹 !فــتــح رابــط / !قــفــل رابــط

*تـفـعـيـل أو تـعـطـيـل مـنـع الـروابـط*

> 🔹 !بــانــد @شــخــص

*حــظــر عــضــو*

> 🔹 !اصــعــد / !انــزل @شــخــص

*رفـع أو تـنـزيـل أدمـن*

> 🔹 !تــوقــف / !تــشــغــيــل

*إسـكـات أو تـشـغـيـل لـونـا*
━━━━━━━━━━━━━━

*🚫 نــظــام الــتــحــذيــرات*

> 🔸 !تــحــذيــر [@شــخــص]

*عــرض عــدد الــتــحــذيــرات*

> 🔸 !ازالــة_تــحــذيــر @شــخــص

*حــذف تــحــذيــر (أدمــن)*
━━━━━━━━━━━━━━

*💍 نــظــام الــعــلاقــات*

> 💗 !زواج @شــخــص [الــمــهــر]

*طــلــب الــزواج*

> 💔 !طــلاق @شــخــص

*إنــهــاء الــزواج*
━━━━━━━━━━━━━━`;

      try {
        const menuImagePath = path.join(__dirname, 'images', 'luna_menu.png');
        const imageBuffer = fs.readFileSync(menuImagePath);
        const media = new MessageMedia('image/png', imageBuffer.toString('base64'));
        await chat.sendMessage(media, { caption: commandsList });
      } catch (imgErr) {
        console.error('فشل تجهيز صورة القائمة:', imgErr.message);
        await message.reply(commandsList);
      }
      return;
    }

    // -------- 6ج) !بروفايل @شخص - يبعت صورة بروفايل الشخص المنشن --------
    if (body.startsWith('!بروفايل')) {
      const mentioned = await message.getMentions();
      // لو ما فيه منشن، بيشتغل عليك انت لحالك (تماماً زي !xp)
      const target = mentioned && mentioned.length > 0 ? mentioned[0] : await message.getContact();
      const picBuffer = await getProfilePicBuffer(target);
      if (!picBuffer) {
        await message.reply('هاد ماله صورة بروفايل ظاهرة، أو خصوصيته ما بتسمح 🚫');
        return;
      }
      const media = new MessageMedia('image/jpeg', picBuffer.toString('base64'));
      await chat.sendMessage(media);
      return;
    }

    // -------- 6ج2) !xp - يبعت كرت نقاط الخبرة والمستوى (نفسك، أو شخص تعمله منشن) --------
    if (body.startsWith('!xp') || body.startsWith('!XP') || body.startsWith('!Xp')) {
      const mentioned = await message.getMentions();
      const targetContact = mentioned && mentioned.length > 0 ? mentioned[0] : await message.getContact();
      const targetId = getCanonicalContactId(targetContact);
      const chatId = chat.id._serialized;

      const statsEntry = getStats(targetId, chatId);
      const picBuffer = await getProfilePicBuffer(targetContact);
      const displayNumber = targetContact.number || targetId.split('@')[0] || '';
      const fallbackLetter = targetContact.pushname || displayNumber || '?';

      try {
        const cardImage = await buildXpCardImage(picBuffer, fallbackLetter, displayNumber, statsEntry);
        const media = new MessageMedia('image/jpeg', cardImage.toString('base64'));
        await chat.sendMessage(media);
      } catch (err) {
        console.error('خطأ بتجهيز كرت XP:', err.message);
        await message.reply('ما قدرت أجهز كرت النقاط هلق، جرب بعد شوي 😅');
      }
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

    // -------- 6) !لونا - يرد على السؤال مع مراعاة سياق المحادثة السابقة --------
    if (body.startsWith('!لونا')) {
      if (!aiEnabled) {
        await message.reply('لونا ساكتة هلق، اكتب !تشغيل عشان ترجع 🤐');
        return;
      }
      const question = body.replace('!لونا', '').trim();
      const prompt = question.length > 0 ? question : 'سلمي علينا يا لونا';
      const history = conversationHistory.get(convoKey) || [];
      const reply = await askAI(prompt, history);
      pushToHistory(convoKey, 'user', prompt);
      pushToHistory(convoKey, 'assistant', reply);
      await message.reply(reply);
      return;
    }

    // -------- 7) رد (Reply) على رسالة من لونا نفسها = ترد عليك بدون أمر (رد نصي) --------
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

    // -------- 8) !صوت - يحول نص لرسالة صوتية بصوت لونا --------
    // استخدام 1: !صوت نص تبيه يتحول صوت
    // استخدام 2: رد (Reply) على رسالة نصية من لونا بـ "!صوت" بدون نص زيادة، يحولها هي لصوت
    if (body.startsWith('!صوت')) {
      if (!aiEnabled) {
        await message.reply('لونا ساكتة هلق، اكتب !تشغيل عشان ترجع 🤐');
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
        await message.reply('اكتب النص اللي بدك تحوله صوت، أو رد (Reply) على رسالة من لونا بـ !صوت 🎙️');
        return;
      }

      try {
        const voiceBuffer = await textToVoiceBuffer(textToSpeak, GROQ_API_KEY);
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
          const transcribedText = await transcribeVoiceBuffer(audioBuffer, media.mimetype, GROQ_API_KEY);

          if (!transcribedText) {
            await message.reply('ما فهمت شي من الصوت، جرب تحكي أوضح 🎙️');
            return;
          }

          const history = conversationHistory.get(convoKey) || [];
          const aiReply = await askAI(transcribedText, history);
          pushToHistory(convoKey, 'user', transcribedText);
          pushToHistory(convoKey, 'assistant', aiReply);

          const voiceBuffer = await textToVoiceBuffer(aiReply, GROQ_API_KEY);
          const voiceMedia = new MessageMedia('audio/ogg; codecs=opus', voiceBuffer.toString('base64'));
          await chat.sendMessage(voiceMedia, { sendAudioAsVoice: true });
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
