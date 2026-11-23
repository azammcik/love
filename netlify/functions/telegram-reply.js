const { getStore } = require("@netlify/blobs");

let memorySchedule = {
  locked: true,
  unlockHourText: "00:00",
  unlockAt: null
};

const BOT_COMMANDS = [
  { command: "admin", description: "Boshqaruv paneli va menyu tugmalari" },
  { command: "help", description: "Barcha komandalar va qo'llanma" },
  { command: "status", description: "Saytning joriy holatini ko'rish" },
  { command: "opennow", description: "Saytni hoziroq ochish" },
  { command: "lock", description: "Belgilangan soatgacha sanoq (masalan: /lock 00:00)" },
  { command: "settime", description: "Aniq sana/soatda avto-ochilish (/settime 2026-11-24T00:00)" }
];

const PERSISTENT_MENU_KEYBOARD = {
  keyboard: [
    [{ text: "🎛 Admin Panel" }, { text: "ℹ️ Holat (Status)" }],
    [{ text: "⏳ 00:00 gacha sanoq" }, { text: "⏰ 00:00 da avto-ochish" }],
    [{ text: "✅ Hoziroq ochish" }, { text: "📖 Yordam (Help)" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

exports.handler = async (event) => {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "TELEGRAM_BOT_TOKEN yoki TELEGRAM_CHAT_ID sozlanmagan" })
    };
  }

  const qs = event.queryStringParameters || {};
  const host = (event.headers && (event.headers["x-forwarded-host"] || event.headers.host)) || "";
  const proto = (event.headers && (event.headers["x-forwarded-proto"] || "https")) || "https";
  const fnUrl = host ? `${proto}://${host}/.netlify/functions/telegram-reply` : "";

  if (qs.setup === "webhook" && fnUrl) {
    const whRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(fnUrl)}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`
    );
    const whData = await whRes.json();
    const cmdData = await registerBotCommands(BOT_TOKEN);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookUrl: fnUrl, telegram: whData, commands: cmdData })
    };
  }

  const storage = createStorage();

  if (event.httpMethod === "GET") {
    const config = await storage.getSchedule();
    const now = Date.now();
    const unlockTs = config.unlockAt ? new Date(config.unlockAt).getTime() : null;
    const isOpen = !config.locked && (!unlockTs || now >= unlockTs);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      },
      body: JSON.stringify({
        isOpen,
        locked: Boolean(config.locked),
        unlockHourText: config.unlockHourText || "00:00",
        unlockAt: config.unlockAt || null,
        storageMode: storage.mode
      })
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Faqat GET va POST ruxsat etilgan" }) };
  }

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "{}");
    const body = JSON.parse(rawBody);

    // 1. Telegram Bot Callback (Inline tugmalar)
    if (body.callback_query) {
      const cq = body.callback_query;
      const incomingChatId = String(cq.message && cq.message.chat ? cq.message.chat.id : "");
      const data = String(cq.data || "");

      if (incomingChatId !== String(CHAT_ID)) {
        await answerCallback(BOT_TOKEN, cq.id, "Ruxsat berilmagan");
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data.startsWith("lock_")) {
        const rawTime = data.slice(5);
        await applyLockCommand(BOT_TOKEN, CHAT_ID, storage, rawTime, cq.id);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data.startsWith("auto_")) {
        const rawTime = data.slice(5);
        await applyAutoCommand(BOT_TOKEN, CHAT_ID, storage, rawTime, cq.id);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data === "open_now") {
        await applyOpenNowCommand(BOT_TOKEN, CHAT_ID, storage, cq.id);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data === "show_status") {
        await answerCallback(BOT_TOKEN, cq.id, "Holat yangilandi");
        await sendStatusMessage(BOT_TOKEN, CHAT_ID, storage, fnUrl);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data === "custom_help") {
        await answerCallback(BOT_TOKEN, cq.id, "Qo'llanma ochildi");
        await sendHelpMessage(BOT_TOKEN, CHAT_ID);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // 2. Telegram Bot Webhook matn buyruqlari va Reply Keyboard tugmalari
    if (body.message && body.message.chat) {
      const incomingChatId = String(body.message.chat.id);
      const text = (body.message.text || "").trim();

      if (incomingChatId !== String(CHAT_ID)) {
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/start" || text === "/admin" || text === "🎛 Admin Panel") {
        if (fnUrl) {
          await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(fnUrl)}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`
          ).catch(() => {});
        }
        await registerBotCommands(BOT_TOKEN).catch(() => {});
        await sendMainMenuWithInline(
          BOT_TOKEN,
          CHAT_ID,
          [
            "🌹 <b>Munisa — Admin Boshqaruv Paneli</b>",
            "",
            "Pastdagi <b>Menyu tugmalari</b> yoki <b>komandalar</b> orqali saytni boshqaring:"
          ].join("\n")
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/help" || text === "📖 Yordam (Help)") {
        await registerBotCommands(BOT_TOKEN).catch(() => {});
        await sendHelpMessage(BOT_TOKEN, CHAT_ID);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "⏳ 00:00 gacha sanoq") {
        await applyLockCommand(BOT_TOKEN, CHAT_ID, storage, "00:00");
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "⏰ 00:00 da avto-ochish") {
        await applyAutoCommand(BOT_TOKEN, CHAT_ID, storage, "00:00");
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text.startsWith("/lock")) {
        const parts = text.split(/\s+/);
        const rawTime = (parts[1] || "00:00").trim();
        await applyLockCommand(BOT_TOKEN, CHAT_ID, storage, rawTime);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text.startsWith("/settime")) {
        const parts = text.slice("/settime".length).trim().split(/\s+/);
        const dateStr = parts.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) && /^\d{1,2}:\d{2}$/.test(parts[1])
          ? `${parts[0]}T${parts[1]}`
          : parts[0];

        if (!dateStr) {
          await sendTgMessage(
            BOT_TOKEN,
            CHAT_ID,
            "Format: <code>/settime 2026-11-24T00:00</code>"
          );
          return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }
        const normalized = dateStr.includes("+") || dateStr.endsWith("Z")
          ? dateStr
          : `${dateStr}:00+05:00`;
        const parsed = new Date(normalized);
        if (Number.isNaN(parsed.getTime())) {
          await sendTgMessage(
            BOT_TOKEN,
            CHAT_ID,
            "❌ Format noto'g'ri. Masalan: <code>/settime 2026-11-24T00:00</code>"
          );
          return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }
        const hhmm = parsed.toLocaleTimeString("uz-UZ", {
          timeZone: "Asia/Tashkent",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });

        const nextConfig = {
          locked: false,
          unlockHourText: hhmm,
          unlockAt: parsed.toISOString()
        };
        const savedOk = await storage.setSchedule(nextConfig);
        const warnText = savedOk ? "" : "\n⚠️ <i>Xotira ogohlantirishi: Netlify Blobs faol emas.</i>";

        await sendMainMenuWithInline(
          BOT_TOKEN,
          CHAT_ID,
          `⏰ <b>Vaqt belgilandi!</b>\nSayt ekranda <b>${hhmm}</b> gacha orqaga sanaydi va shu vaqtda avtomatik ochiladi.${warnText}`
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/opennow" || text === "✅ Hoziroq ochish") {
        await applyOpenNowCommand(BOT_TOKEN, CHAT_ID, storage);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/status" || text === "ℹ️ Holat (Status)") {
        await sendStatusMessage(BOT_TOKEN, CHAT_ID, storage, fnUrl);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // 3. Saytdan keladigan bildirishnomalar va javoblar
    const type = body.type || "reply";

    if (type === "opened") {
      await sendTgMessage(BOT_TOKEN, CHAT_ID, "✨ <b>Munisa syurprizni ochdi!</b>\nHozir maktubni o'qiyapti... 🌹");
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (type === "yes") {
      await sendTgMessage(BOT_TOKEN, CHAT_ID, "💍🥂 <b>MUNISA «HA, SEVAMAN!» DEB JAVOB BERDI!</b> 🌹✨");
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (type === "dreams") {
      const list = (body.dreams || []).map((d, i) => `${i + 1}. ${d}`).join("\n");
      await sendTgMessage(
        BOT_TOKEN,
        CHAT_ID,
        `🌙 <b>Munisa tanlagan orzular:</b>\n\n${list || "Hech biri tanlanmadi"}`
      );
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    const msg = (body.message || "").trim();
    const photoBase64 = body.photoBase64 || null;
    const photoName = body.photoName || "munisa-photo.jpg";
    const photoMime = body.photoMime || "image/jpeg";

    if (!msg && !photoBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: "Xabar yoki rasm bo'sh" }) };
    }

    if (photoBase64) {
      const photoBuffer = Buffer.from(photoBase64, "base64");
      const formData = new FormData();
      formData.append("chat_id", String(CHAT_ID));
      formData.append(
        "caption",
        msg
          ? `💌 <b>Munisadan xabar va rasm:</b>\n\n«${escapeHtml(msg)}»`
          : "📸 <b>Munisadan yangi rasm!</b> 🌹"
      );
      formData.append("parse_mode", "HTML");
      formData.append("photo", new Blob([photoBuffer], { type: photoMime }), photoName);

      const tgPhotoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        body: formData
      });
      const tgPhotoData = await tgPhotoRes.json();
      if (!tgPhotoData.ok) {
        return {
          statusCode: 502,
          body: JSON.stringify({ error: "Rasm yuborishda Telegram xatosi", details: tgPhotoData.description })
        };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    await sendTgMessage(
      BOT_TOKEN,
      CHAT_ID,
      `💌 <b>Munisadan yangi javob keldi:</b>\n\n«${escapeHtml(msg)}»`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    if (BOT_TOKEN && CHAT_ID) {
      await sendTgMessage(
        BOT_TOKEN,
        CHAT_ID,
        `❌ <b>Xatolik yuz berdi:</b>\n<code>${escapeHtml(err.message || String(err))}</code>`
      ).catch(() => {});
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server xatosi", details: err.message })
    };
  }
};

async function applyLockCommand(token, chatId, storage, rawTime, callbackId) {
  const targetInfo = resolveNextTimeInTashkent(rawTime);
  const nextConfig = {
    locked: true,
    unlockHourText: targetInfo.hhmm,
    unlockAt: targetInfo.iso
  };
  const savedOk = await storage.setSchedule(nextConfig);
  if (callbackId) {
    await answerCallback(token, callbackId, `${targetInfo.hhmm} gacha sanoq yoqildi`);
  }
  const warnText = savedOk ? "" : "\n⚠️ <i>Xotira ogohlantirishi: Netlify Blobs faol emas.</i>";
  await sendMainMenuWithInline(
    token,
    chatId,
    `⏳ <b>Orqaga sanoq yoqildi!</b>\nSaytda <b>${escapeHtml(targetInfo.hhmm)}</b> gacha (Toshkent vaqti) jonli sanoq ketadi.${warnText}`
  );
}

async function applyAutoCommand(token, chatId, storage, rawTime, callbackId) {
  const targetInfo = resolveNextTimeInTashkent(rawTime);
  const nextConfig = {
    locked: false,
    unlockHourText: targetInfo.hhmm,
    unlockAt: targetInfo.iso
  };
  const savedOk = await storage.setSchedule(nextConfig);
  if (callbackId) {
    await answerCallback(token, callbackId, `${targetInfo.hhmm} da avto-ochilish yoqildi`);
  }
  const warnText = savedOk ? "" : "\n⚠️ <i>Xotira ogohlantirishi: Netlify Blobs faol emas.</i>";
  await sendMainMenuWithInline(
    token,
    chatId,
    `⏰ <b>Avtomatik ochilish vaqti belgilandi!</b>\nSayt <b>${escapeHtml(targetInfo.hhmm)}</b> gacha sanaydi va shu vaqtda avtomatik ochiladi.${warnText}`
  );
}

async function applyOpenNowCommand(token, chatId, storage, callbackId) {
  await storage.setSchedule({
    locked: false,
    unlockHourText: null,
    unlockAt: null
  });
  if (callbackId) {
    await answerCallback(token, callbackId, "Sayt ochildi!");
  }
  await sendMainMenuWithInline(
    token,
    chatId,
    "✅ <b>Sayt hoziroq ochildi!</b>\nMunisa endi sahifaga to'g'ridan-to'g'ri kira oladi."
  );
}

async function registerBotCommands(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: BOT_COMMANDS })
  });
  await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ menu_button: { type: "commands" } })
  }).catch(() => {});
  return res.json();
}

function createStorage() {
  let blobStore = null;
  try {
    blobStore = getStore({
      name: "munisa-site-config",
      consistency: "strong"
    });
  } catch (_) {
    try {
      blobStore = getStore("munisa-site-config");
    } catch (__) {
      blobStore = null;
    }
  }

  return {
    mode: blobStore ? "netlify-blobs" : "memory-fallback",
    async getSchedule() {
      if (blobStore) {
        try {
          const saved = await blobStore.get("schedule", { type: "json" });
          if (saved && typeof saved === "object") {
            memorySchedule = { ...memorySchedule, ...saved };
            return memorySchedule;
          }
        } catch (_) {
          // fallback
        }
      }
      return memorySchedule;
    },
    async setSchedule(nextConfig) {
      memorySchedule = { ...nextConfig };
      if (!blobStore) {
        return false;
      }
      try {
        await blobStore.setJSON("schedule", memorySchedule);
        return true;
      } catch (_) {
        return false;
      }
    }
  };
}

async function sendHelpMessage(token, chatId) {
  const helpText = [
    "📖 <b>Munisa Bot — Komandalar va Qo'llanma</b>",
    "",
    "<b>1. Asosiy komandalar:</b>",
    "• <code>/admin</code> — Boshqaruv paneli va pastki menyu tugmalarini chiqarish",
    "• <code>/help</code> — Ushbu qo'llanmani ko'rish",
    "• <code>/status</code> — Saytning joriy holatini tekshirish",
    "• <code>/opennow</code> — Saytni darhol ochish",
    "",
    "<b>2. Vaqt va orqaga sanoq komandalari (Toshkent vaqti):</b>",
    "• <code>/lock 00:00</code> — Keyingi 00:00 gacha orqaga sanoq (yopiq holatda qoladi)",
    "• <code>/lock 23:30</code> — Keyingi 23:30 gacha orqaga sanoq",
    "• <code>/settime 2026-11-24T00:00</code> — Ko'rsatilgan sana/soatgacha sanab, shu vaqtda avtomatik ochiladi",
    "",
    "<b>3. Menyu tugmalari:</b>",
    "Pastdagi klaviatura tugmalari (<i>Admin Panel, Holat, 00:00 gacha sanoq, 00:00 da avto-ochish, Hoziroq ochish, Yordam</i>) orqali komanda yozmasdan boshqarishingiz mumkin."
  ].join("\n");

  await sendTgMessage(token, chatId, helpText, PERSISTENT_MENU_KEYBOARD);
}

async function sendStatusMessage(token, chatId, storage, fnUrl) {
  const config = await storage.getSchedule();
  const info = config.locked
    ? `🔒 <b>Holat:</b> Orqaga sanoq faol (maqsad: <b>${escapeHtml(config.unlockHourText || "00:00")}</b>)`
    : config.unlockAt
      ? `⏰ <b>Avto-ochilish:</b> <b>${escapeHtml(config.unlockHourText)}</b> da avtomatik ochiladi`
      : "✅ <b>Holat:</b> Ochiq (ruxsat berilgan)";

  const extra = `\n📦 Xotira: <code>${escapeHtml(storage.mode)}</code>` +
    (fnUrl ? `\n🔗 Webhook link: <code>${escapeHtml(fnUrl + "?setup=webhook")}</code>` : "");
  await sendTgMessage(token, chatId, info + extra, PERSISTENT_MENU_KEYBOARD);
}

async function sendMainMenuWithInline(token, chatId, text) {
  await sendTgMessage(token, chatId, text, PERSISTENT_MENU_KEYBOARD);

  const inlineMarkup = {
    inline_keyboard: [
      [
        { text: "⏳ 00:00 gacha sanoq", callback_data: "lock_00:00" },
        { text: "⏳ 21:00 gacha sanoq", callback_data: "lock_21:00" }
      ],
      [
        { text: "⏳ 22:00 gacha sanoq", callback_data: "lock_22:00" },
        { text: "⏳ 23:00 gacha sanoq", callback_data: "lock_23:00" }
      ],
      [
        { text: "⏰ 00:00 da avto-ochish", callback_data: "auto_00:00" },
        { text: "✅ Hoziroq ochish", callback_data: "open_now" }
      ],
      [
        { text: "📖 Qo'llanma (Help)", callback_data: "custom_help" },
        { text: "ℹ️ Holatni ko'rish", callback_data: "show_status" }
      ]
    ]
  };

  await sendTgMessage(
    token,
    chatId,
    "⚡ <b>Tezkor soat tanlash:</b>",
    inlineMarkup
  );
}

async function answerCallback(token, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    })
  }).catch(() => {});
}

function resolveNextTimeInTashkent(rawTime) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(rawTime);
  const targetH = match ? Math.min(23, Math.max(0, parseInt(match[1], 10))) : 0;
  const targetM = match ? Math.min(59, Math.max(0, parseInt(match[2], 10))) : 0;
  const hhmm = `${String(targetH).padStart(2, "0")}:${String(targetM).padStart(2, "0")}`;

  const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
  const now = Date.now();
  const tashkentNow = new Date(now + TASHKENT_OFFSET_MS);

  const year = tashkentNow.getUTCFullYear();
  const month = tashkentNow.getUTCMonth();
  const day = tashkentNow.getUTCDate();

  let targetUtcMs = Date.UTC(year, month, day, targetH, targetM, 0, 0) - TASHKENT_OFFSET_MS;
  if (targetUtcMs <= now) {
    targetUtcMs += 24 * 60 * 60 * 1000;
  }

  return {
    hhmm,
    iso: new Date(targetUtcMs).toISOString()
  };
}

async function sendTgMessage(token, chatId, text, replyMarkup) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const tgData = await tgRes.json();
  if (!tgData.ok) {
    throw new Error(tgData.description || "Telegram sendMessage xatosi");
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
