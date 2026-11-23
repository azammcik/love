const { getStore } = require("@netlify/blobs");

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

  let store = null;
  try {
    store = getStore("munisa-site-config");
  } catch (_) {
    store = null;
  }

  // GET: Sayt ochilgan yoki yopiqligini va orqaga sanoq vaqtini qaytaradi
  if (event.httpMethod === "GET") {
    let config = {
      locked: true,
      unlockHourText: "00:00",
      unlockAt: null
    };
    if (store) {
      const saved = await store.get("schedule", { type: "json" }).catch(() => null);
      if (saved) config = { ...config, ...saved };
    }

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
        unlockAt: config.unlockAt || null
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

    // 1. Telegram Bot Webhook buyruqlari
    if (body.message && body.message.chat) {
      const incomingChatId = String(body.message.chat.id);
      const text = (body.message.text || "").trim();

      if (incomingChatId !== String(CHAT_ID)) {
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/start" || text === "/help") {
        await sendTgMessage(
          BOT_TOKEN,
          CHAT_ID,
          "🌹 <b>Munisa — Syurpriz Boshqaruv Boti</b>\n\n" +
          "Buyruqlar:\n" +
          "⏳ <code>/lock 00:00</code> — Bugun/keyingi <b>00:00</b> gacha orqaga sanoqni yoqish (masalan: <code>/lock 23:30</code>)\n" +
          "⏰ <code>/settime 2026-11-24T00:00</code> — Aniq sana va vaqtgacha orqaga sanoq va avtomatik ochilish\n" +
          "✅ <code>/opennow</code> — Saytga kirishga hoziroq ruxsat berish\n" +
          "ℹ️ <code>/status</code> — Joriy holatni ko'rish"
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text.startsWith("/lock")) {
        const parts = text.split(/\s+/);
        const rawTime = (parts[1] || "00:00").trim();
        const targetInfo = resolveNextTimeInTashkent(rawTime);
        if (store) {
          await store.setJSON("schedule", {
            locked: true,
            unlockHourText: targetInfo.hhmm,
            unlockAt: targetInfo.iso
          });
        }
        await sendTgMessage(
          BOT_TOKEN,
          CHAT_ID,
          `⏳ Orqaga sanoq yoqildi!\nEkranda romantik so'zlar bilan <b>${escapeHtml(targetInfo.hhmm)}</b> gacha sanoq ketadi.`
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text.startsWith("/settime")) {
        const parts = text.split(/\s+/);
        const dateStr = parts[1];
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
        if (store) {
          await store.setJSON("schedule", {
            locked: false,
            unlockHourText: hhmm,
            unlockAt: parsed.toISOString()
          });
        }
        await sendTgMessage(
          BOT_TOKEN,
          CHAT_ID,
          `⏰ Vaqt belgilandi! Sayt ekranda <b>${hhmm}</b> gacha orqaga sanaydi va shu vaqtda avtomatik ochiladi.`
        );
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/opennow") {
        if (store) {
          await store.setJSON("schedule", {
            locked: false,
            unlockHourText: null,
            unlockAt: null
          });
        }
        await sendTgMessage(BOT_TOKEN, CHAT_ID, "✅ Ruxsat berildi! Munisa endi saytga bemalol kira oladi.");
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (text === "/status") {
        let config = { locked: true, unlockHourText: "00:00", unlockAt: null };
        if (store) {
          const saved = await store.get("schedule", { type: "json" }).catch(() => null);
          if (saved) config = { ...config, ...saved };
        }
        const info = config.locked
          ? `🔒 Holat: Orqaga sanoq faol (maqsad: <b>${escapeHtml(config.unlockHourText || "00:00")}</b>)`
          : config.unlockAt
            ? `⏰ Avto-ochilish: <b>${escapeHtml(config.unlockHourText)}</b>`
            : "✅ Holat: Ochiq (ruxsat berilgan)";
        await sendTgMessage(BOT_TOKEN, CHAT_ID, info);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // 2. Saytdan keladigan bildirishnomalar va javoblar
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server xatosi", details: err.message })
    };
  }
};

function resolveNextTimeInTashkent(rawTime) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(rawTime);
  const targetH = match ? Math.min(23, Math.max(0, parseInt(match[1], 10))) : 0;
  const targetM = match ? Math.min(59, Math.max(0, parseInt(match[2], 10))) : 0;
  const hhmm = `${String(targetH).padStart(2, "0")}:${String(targetM).padStart(2, "0")}`;

  // Asia/Tashkent is UTC+5
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
