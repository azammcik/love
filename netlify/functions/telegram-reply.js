exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Faqat POST ruxsat etilgan" }) };
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server sozlamalarida Token yoki Chat ID kiritilmagan" })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const type = body.type || "reply";
    let text = "";

    if (type === "opened") {
      text = "✨ <b>Munisa saytni ochdi!</b>\nHozir xatni o'qiyapti... ❤️";
    } else if (type === "yes") {
      text = "💍🎉 <b>MUNISA «HA, SEVAMAN!» TUGMASINI BOSDI!</b> ❤️🥳";
    } else if (type === "dreams") {
      const list = (body.dreams || []).map((d, i) => `${i + 1}. ${d}`).join("\n");
      text = `🌙 <b>Munisa tanlagan orzular:</b>\n\n${list || "Hech biri tanlanmadi"}`;
    } else {
      const msg = (body.message || "").trim();
      if (!msg) {
        return { statusCode: 400, body: JSON.stringify({ error: "Xabar bo'sh" }) };
      }
      text = `💌 <b>Munisadan yangi javob keldi:</b>\n\n«${escapeHtml(msg)}»`;
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        parse_mode: "HTML"
      })
    });

    const tgData = await tgRes.json();

    if (!tgData.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Telegram xatosi", details: tgData.description })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server xatosi", details: err.message })
    };
  }
};

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
