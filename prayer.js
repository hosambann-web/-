// ============ ملف أوقات الصلاة (ليبيا، مصر، الجزائر، المغرب، تونس) ============
// كل شغل الصلاة بتاع لونا موجود هون، منفصل عن index.js عشان التنظيم (زي voice.js بالظبط)
//
// المصدر: Aladhan API (مجاني، بدون مفتاح API) - http://api.aladhan.com
// الفكرة:
//  1) نكتشف دولة العضو تلقائياً من رمز رقمه (بالخاص بس، مش بالجروب)
//  2) !صلاة يرجع أوقات اليوم لدولته
//  3) !تفعيل_تنبيه_الصلاة / !ايقاف_تنبيه_الصلاة يشترك/يلغي اشتراك التنبيه التلقائي وقت كل أذان
//  4) سكيدولر (setInterval كل دقيقة) يفحص كل دولة بتوقيتها المحلي، ولو دخل وقت صلاة
//     يبعت تنبيه بالخاص لكل مشترك من نفس الدولة

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ============ إعدادات الدول المدعومة ============
// city/country: تُستخدم كموقع افتراضي لطلب Aladhan API (عاصمة كل دولة)
// timezone: IANA timezone عشان نعرف الوقت المحلي الحقيقي بكل دولة ونقارنه بأوقات الصلاة
// dialCode: رمز الدولة الدولي (بدون +) عشان نكتشف دولة العضو من رقمه
const COUNTRIES = {
  libya:   { name: 'ليبيا',   city: 'Tripoli',    country: 'Libya',   timezone: 'Africa/Tripoli',    dialCode: '218' },
  egypt:   { name: 'مصر',     city: 'Cairo',       country: 'Egypt',   timezone: 'Africa/Cairo',      dialCode: '20'  },
  algeria: { name: 'الجزائر', city: 'Algiers',     country: 'Algeria', timezone: 'Africa/Algiers',    dialCode: '213' },
  morocco: { name: 'المغرب',  city: 'Rabat',       country: 'Morocco', timezone: 'Africa/Casablanca', dialCode: '212' },
  tunisia: { name: 'تونس',    city: 'Tunis',       country: 'Tunisia', timezone: 'Africa/Tunis',      dialCode: '216' }
};

// ترتيب الفحص مهم: أرقام الدول ذات 3 خانات (218/213/212/216) لازم تتفحص قبل مصر (20)
// عشان رقم زي 218... ما ينكشفش غلط كـ "20..." (مافيش تعارض فعلي هون لأن 218 ميبدأش بـ20، بس منحافظ على الترتيب للأمان)
const DIAL_CODE_ORDER = ['libya', 'algeria', 'morocco', 'tunisia', 'egypt'];

const PRAYER_NAMES_AR = {
  Fajr: 'الفجر',
  Dhuhr: 'الظهر',
  Asr: 'العصر',
  Maghrib: 'المغرب',
  Isha: 'العشاء'
};
const TRACKED_PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

// ============ اكتشاف دولة العضو من رقم هاتفه ============
// numberOnly: الرقم بدون @c.us وبدون + (مثلاً "218912345678")
function detectCountryFromNumber(numberOnly) {
  if (!numberOnly) return null;
  const clean = numberOnly.replace(/\D/g, '');
  for (const key of DIAL_CODE_ORDER) {
    const dial = COUNTRIES[key].dialCode;
    if (clean.startsWith(dial)) return key;
  }
  return null;
}

function detectCountryFromContact(contact) {
  if (!contact) return null;
  const number = contact.number || (contact.id && contact.id.user) || '';
  return detectCountryFromNumber(number);
}

// ============ تخزين المشتركين بالتنبيه التلقائي ============
// كل دالة بتاخد persistDir عشان تخزن جوه persist/data زي باقي ملفات JSON بالبوت
function getSubscribersFile(persistDir) {
  return path.join(persistDir, 'data', 'prayer_subscribers.json');
}

function loadSubscribers(persistDir) {
  try {
    const file = getSubscribersFile(persistDir);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  } catch (err) {
    console.error('خطأ بقراءة ملف مشتركي الصلاة:', err.message);
    return {};
  }
}

function saveSubscribers(persistDir, subscribers) {
  try {
    const file = getSubscribersFile(persistDir);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(subscribers, null, 2), 'utf8');
  } catch (err) {
    console.error('خطأ بحفظ ملف مشتركي الصلاة:', err.message);
  }
}

// userId: معرف واتساب كامل (مثلاً "218912345678@c.us")، countryKey: مفتاح من COUNTRIES
function subscribeUser(persistDir, userId, countryKey) {
  const subs = loadSubscribers(persistDir);
  subs[userId] = countryKey;
  saveSubscribers(persistDir, subs);
}

function unsubscribeUser(persistDir, userId) {
  const subs = loadSubscribers(persistDir);
  if (subs[userId]) {
    delete subs[userId];
    saveSubscribers(persistDir, subs);
    return true;
  }
  return false;
}

// ============ جلب أوقات الصلاة من Aladhan (مع كاش يومي لكل دولة) ============
// الكاش بمنع طلب API متكرر لكل رسالة/فحص - نجيب أوقات كل دولة مرة وحدة كل يوم بس
const timingsCache = new Map(); // key: countryKey_YYYY-MM-DD, value: { Fajr, Dhuhr, Asr, Maghrib, Isha }

function todayDateKeyForZone(timezone) {
  // تاريخ اليوم بصيغة YYYY-MM-DD حسب المنطقة الزمنية المطلوبة (مو منطقة السيرفر)
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone }); // en-CA بيرجع YYYY-MM-DD مباشرة
}

async function getTodayTimings(countryKey) {
  const cfg = COUNTRIES[countryKey];
  if (!cfg) return null;

  const dateKey = todayDateKeyForZone(cfg.timezone);
  const cacheKey = `${countryKey}_${dateKey}`;
  if (timingsCache.has(cacheKey)) return timingsCache.get(cacheKey);

  try {
    const response = await axios.get('https://api.aladhan.com/v1/timingsByCity', {
      params: { city: cfg.city, country: cfg.country, method: 3 },
      timeout: 10000
    });
    const t = response.data?.data?.timings;
    if (!t) return null;

    // Aladhan بيرجع أحياناً وقت بصيغة "05:23 (EET)" - منقص أي جزء زيادة بعد الرقم
    const clean = {};
    TRACKED_PRAYERS.forEach((p) => {
      clean[p] = (t[p] || '').split(' ')[0];
    });

    timingsCache.set(cacheKey, clean);
    // تنظيف كاش الأيام القديمة عشان الخريطة ما تكبرش للأبد
    for (const key of timingsCache.keys()) {
      if (!key.startsWith(countryKey) && key.split('_')[1] < dateKey) timingsCache.delete(key);
    }
    return clean;
  } catch (err) {
    console.error(`خطأ بجلب أوقات الصلاة (${countryKey}):`, err.message);
    return null;
  }
}

// ============ رسالة أوقات الصلاة (رد على أمر !صلاة) ============
function formatPrayerTimesMessage(countryKey, timings) {
  const cfg = COUNTRIES[countryKey];
  const lines = [
    '⌬──══─┈•⤣🕌⤤•┈─══──⌬',
    `🕌⃝⚡ *أوقات الصلاة اليوم - ${cfg.name}*`,
    ''
  ];
  TRACKED_PRAYERS.forEach((p) => {
    lines.push(`${PRAYER_NAMES_AR[p]}: *${timings[p] || '—'}*`);
  });
  lines.push('', '⌬──══─┈•⤣🕌⤤•┈─══──⌬');
  return lines.join('\n');
}

function unsupportedCountryMessage() {
  return 'ما قدرت أحدد دولتك من رقمك 😅\nهاي الميزة تدعم حالياً: ليبيا 🇱🇾 مصر 🇪🇬 الجزائر 🇩🇿 المغرب 🇲🇦 تونس 🇹🇳 بس.';
}

function subscribedBanner(countryName) {
  return `✅ تم تفعيل تنبيه الصلاة التلقائي! رح أبعتلك رسالة بالخاص وقت كل أذان (${countryName}) 🕌\nاكتب !ايقاف_تنبيه_الصلاة لو بديت توقفه.`;
}

function unsubscribedBanner() {
  return '🔕 تم إيقاف تنبيه الصلاة التلقائي. اكتب !تفعيل_تنبيه_الصلاة لو بديت ترجعه.';
}

function azanNotificationMessage(prayerNameAr, countryName) {
  return `🕌 حان الآن موعد أذان *${prayerNameAr}* (${countryName}) 🤲`;
}

// ============ السكيدولر: يفحص كل دقيقة، ولو دخل وقت صلاة يبعت تنبيه للمشتركين ============
// client: كائن whatsapp-web.js Client (نفسه المستخدم بـ index.js) عشان نقدر نبعت رسائل
// persistDir: نفس PERSIST_DIR المستخدم بباقي البوت
// بنتذكر آخر وقت صلاة اتبعت تنبيهه لكل دولة عشان ما نكرر نفس التنبيه لو الفحص وقع أكتر من مرة بنفس الدقيقة
const lastNotifiedKey = new Map(); // key: countryKey, value: "YYYY-MM-DD_PrayerName"

function startPrayerScheduler(client, persistDir) {
  setInterval(async () => {
    for (const countryKey of Object.keys(COUNTRIES)) {
      try {
        const cfg = COUNTRIES[countryKey];
        const timings = await getTodayTimings(countryKey);
        if (!timings) continue;

        const nowStr = new Date().toLocaleTimeString('en-GB', {
          timeZone: cfg.timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }); // "HH:MM"
        const dateKey = todayDateKeyForZone(cfg.timezone);

        for (const prayer of TRACKED_PRAYERS) {
          if (timings[prayer] !== nowStr) continue;

          const notifyKey = `${dateKey}_${prayer}`;
          if (lastNotifiedKey.get(countryKey) === notifyKey) continue; // تنبيه هاد الصلاة اتبعت أصلاً اليوم
          lastNotifiedKey.set(countryKey, notifyKey);

          const subs = loadSubscribers(persistDir);
          const userIds = Object.keys(subs).filter((uid) => subs[uid] === countryKey);
          for (const userId of userIds) {
            try {
              await client.sendMessage(userId, azanNotificationMessage(PRAYER_NAMES_AR[prayer], cfg.name));
            } catch (sendErr) {
              console.error(`خطأ ببعت تنبيه أذان لـ ${userId}:`, sendErr.message);
            }
          }
        }
      } catch (err) {
        console.error(`خطأ بفحص أوقات الصلاة (${countryKey}):`, err.message);
      }
    }
  }, 60 * 1000); // كل دقيقة
}

module.exports = {
  COUNTRIES,
  detectCountryFromNumber,
  detectCountryFromContact,
  subscribeUser,
  unsubscribeUser,
  getTodayTimings,
  formatPrayerTimesMessage,
  unsupportedCountryMessage,
  subscribedBanner,
  unsubscribedBanner,
  startPrayerScheduler
};
