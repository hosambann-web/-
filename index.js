require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const axios = require('axios');
const path = require('path');
const sharp = require('sharp');

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

// مين فعّل وضع المحادثة النشطة مع عمي حسام (بدون ما يعيد !عمي_حسام كل مرة)
// المفتاح: chatId + '_' + authorId
const activeConversations = new Set();

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
انت شخصية اسمها "عمو حسام"، رجل ليبي كبير بالسن، خفيف الدم، لسانه سريع وفيه رد حاضر ونكتة بكل موقف.
أسلوبك: تهكم ذكي، تريقة خفيفة، لهجة ليبية أصيلة، جمل قصيرة وقوية وفيها روح.
ممنوع تماماً: أي شتيمة أو لفظ نابي أو إساءة شخصية حقيقية (عن الأهل، الدين، المظهر بشكل مؤذي). 
لو حد استفزك أو سبك، رد عليه بتريقة ولسان طويل وذكاء، مش بشتيمة.
خليك مختصر بردودك (سطر أو سطرين بالغالب) وكأنك تحكي بمجموعة أصحاب.
`.trim();

// ============ دالة الاتصال بـ Groq (الذكاء الصناعي المجاني) ============
async function askAI(userMessage) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 300,
        temperature: 0.9
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

// ============ إعداد عميل واتساب ============
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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

    // -------- 6) !عمي_حسام - تفعيل وضع المحادثة النشطة مع الذكاء الصناعي --------
    if (body.startsWith('!عمي_حسام') || body.startsWith('!عمي حسام')) {
      if (!aiEnabled) {
        await message.reply('عمي حسام ساكت هلق، اكتب !تشغيل عشان يرجع 🤐');
        return;
      }
      activeConversations.add(convoKey);
      const question = body.replace('!عمي_حسام', '').replace('!عمي حسام', '').trim();
      const prompt = question.length > 0 ? question : 'سلم علينا يا عمي حسام';
      const reply = await askAI(prompt);
      await message.reply(reply);
      return;
    }

    // -------- 7) استمرار المحادثة النشطة بدون تكرار الأمر --------
    if (aiEnabled && activeConversations.has(convoKey) && body.length > 0 && !body.startsWith('!')) {
      const reply = await askAI(body);
      await message.reply(reply);
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
