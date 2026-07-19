FROM node:18-bookworm-slim

# نصب Chromium الحقيقي + كل المكتبات اللي محتاجها (Debian مش Ubuntu، فمافيش مشكلة snap)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    fonts-liberation \
    libglib2.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libx11-6 \
    libxext6 \
    libxi6 \
    libxtst6 \
    ca-certificates \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# نمنع Puppeteer من محاولة تنزيل نسخته الخاصة (هنستخدم Chromium اللي نصبناه فوق)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# سقف لذاكرة Node.js نفسه (مش كروميوم) عشان ميزيدش على حساب الرام اللي كروميوم محتاجها
ENV NODE_OPTIONS=--max-old-space-size=200

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
