const { getStore } = require("@netlify/blobs");

let memorySchedule = {
  locked: true,
  unlockHourText: "00:00",
  unlockAt: null
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
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookUrl: fnUrl, telegram: whData })
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
        const targetInfo = resolveNextTimeInTashkent(rawTime);
        const nextConfig = {
          locked: true,
          unlockHourText: targetInfo.hhmm,
          unlockAt: targetInfo.iso
        };
        const savedOk = await storage.setSchedule(nextConfig);
        await answerCallback(BOT_TOKEN, cq.id, `${targetInfo.hhmm} gacha sanoq yoqildi`);
        const warnText = savedOk ? "" : "\n⚠️ <i>Xotira ogohlantirishi: Netlify Blobs faol emas.</i>";
        await sendAdminPanel(
          BOT_TOKEN,
          CHAT_ID,
          `⏳ <b>Orqaga sanoq yoqildi!</b>\nSaytda <b>${escapeHtml(targetInfo.hhmm)}</b> gacha (Toshkent vaqti) jonli sanoq ketadi.${warnText}`
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data.startsWith("auto_")) {
        const rawTime = data.slice(5);
        const targetInfo = resolveNextTimeInTashkent(rawTime);
        const nextConfig = {
          locked: false,
          unlockHourText: targetInfo.hhmm,
          unlockAt: targetInfo.iso
        };
        const savedOk = await storage.setSchedule(nextConfig);
        await answerCallback(BOT_TOKEN, cq.id, `${targetInfo.hhmm} da avto-ochilish yoqildi`);
        const warnText = savedOk ? "" : "\n⚠️ <i>Xotira ogohlantirishi: Netlify Blobs faol emas.</i>";
        await sendAdminPanel(
          BOT_TOKEN,
          CHAT_ID,
          `⏰ <b>Avtomatik ochilish vaqti belgilandi!</b>\nSayt <b>${escapeHtml(targetInfo.hhmm)}</b> gacha sanaydi va shu vaqtda avtomatik ochiladi.${warnText}`
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data === "open_now") {
        const nextConfig = {
          locked: false,
          unlockHourText: null,
          unlockAt: null
        };
        await storage.setSchedule(nextConfig);
        await answerCallback(BOT_TOKEN, cq.id, "Sayt ochildi!");
        await sendAdminPanel(
          BOT_TOKEN,
          CHAT_ID,
          "✅ <b>Sayt hoziroq ochildi!</b>\nMunisa endi sahifaga to'g'ridan-to'g'ri kira oladi."
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data === "show_status") {
        await answerCallback(BOT_TOKEN, cq.id, "Holat yangilandi");
        await sendStatusMessage(BOT_TOKEN, CHAT_ID, storage, fnUrl);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (data === "custom_help") {
        await answerCallback(BOT_TOKEN, cq.id, "Qo'lda vaqt kiritish");
        await sendTgMessage(
          BOT_TOKEN,
          CHAT_ID,
          [
            "⌨️ <b>Qo'lda aniq vaqt belgilash:</b>",
            "",
            "• <code>/lock 23:45</code> — Toshkent vaqti bilan keyingi 23:45 gacha orqaga sanoq (yopiq holatda)",
            "• <code>/settime 2026-11-24T00:00</code> — Aniq sana va vaqtgacha sanoq + vaqti kelganda avtomatik ochilish",
            "• <code>/opennow</code> — Darhol ochish"
          ].join("\n")
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // 2. Telegram Bot Webhook matn buyruqlari
    if (body.message && body.message.chat) {
      const incomingChatId = String(body.message.chat.id);
      const text = (body.message.text || "").trim();

      if (incomingChatId !== String(CHAT_ID)) {
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/start" || text === "/help" || text === "/admin") {
        if (fnUrl) {
          await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(fnUrl)}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`
          ).catch(() => {});
        }
        await sendAdminPanel(
          BOT_TOKEN,
          CHAT_ID,
          [
            "🌹 <b>Munisa — Admin Boshqaruv Paneli</b>",
            "",
            "Tugmalar orqali tez sozlang yoki buyruqlardan foydalaning:",
            "• <code>/lock 00:00</code> — Keyingi 00:00 gacha orqaga sanoq",
            "• <code>/settime 2026-11-24T00:00</code> — Aniq sana/soatgacha sanoq + avto-ochilish",
            "• <code>/opennow</code> — Darhol ochish",
            "• <code>/status</code> — Joriy holat"
          ].join("\n")
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text.startsWith("/lock")) {
        const parts = text.split(/\s+/);
        const rawTime = (parts[1] || "00:00").trim();
        const targetInfo = resolveNextTimeInTashkent(rawTime);
        const nextConfig = {
          locked: true,
          unlockHourText: targetInfo.hhmm,
          unlockAt: targetInfo.iso
        };
        const savedOk = await storage.setSchedule(nextConfig);
        const warnText = savedOk ? "" : "\n⚠️ <i>Xotira ogohlantirishi: Netlify Blobs faol emas.</i>";

        await sendAdminPanel(
          BOT_TOKEN,
          CHAT_ID,
          `⏳ <b>Orqaga sanoq yoqildi!</b>\nEkranda <b>${escapeHtml(targetInfo.hhmm)}</b> gacha jonli sanoq ketadi.${warnText}`
        );
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

        await sendAdminPanel(
          BOT_TOKEN,
          CHAT_ID,
          `⏰ <b>Vaqt belgilandi!</b>\nSayt ekranda <b>${hhmm}</b> gacha orqaga sanaydi va shu vaqtda avtomatik ochiladi.${warnText}`
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/opennow") {
        await storage.setSchedule({
          locked: false,
          unlockHourText: null,
          unlockAt: null
        });
        await sendAdminPanel(BOT_TOKEN, CHAT_ID, "✅ <b>Ruxsat berildi!</b> Munisa endi saytga bemalol kira oladi.");
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/status") {
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

async function sendStatusMessage(token, chatId, storage, fnUrl) {
  const config = await storage.getSchedule();
  const info = config.locked
    ? `🔒 <b>Holat:</b> Orqaga sanoq faol (maqsad: <b>${escapeHtml(config.unlockHourText || "00:00")}</b>)`
    : config.unlockAt
      ? `⏰ <b>Avto-ochilish:</b> <b>${escapeHtml(config.unlockHourText)}</b> da avtomatik ochiladi`
      : "✅ <b>Holat:</b> Ochiq (ruxsat berilgan)";

  const extra = `\n📦 Xotira: <code>${escapeHtml(storage.mode)}</code>` +
    (fnUrl ? `\n🔗 Webhook link: <code>${escapeHtml(fnUrl + "?setup=webhook")}</code>` : "");
  await sendTgMessage(token, chatId, info + extra);
}

async function sendAdminPanel(token, chatId, text) {
  const replyMarkup = {
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
        { text: "⌨️ Qo'lda vaqt yozish", callback_data: "custom_help" },
        { text: "ℹ️ Holatni ko'rish", callback_data: "show_status" }
      ]
    ]
  };

  const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup
    })
  });
  const tgData = await tgRes.json();
  if (!tgData.ok) {
    throw new Error(tgData.description || "Telegram sendMessage xatosi");
  }
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

async function sendTgMessage(token, chatId, text) {
  const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    })
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
