const https = require("https");

exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return json(500, {
      error: "Telegram credentials not configured",
      details: "Netlify Dashboard → Environment variables ga TELEGRAM_BOT_TOKEN va TELEGRAM_CHAT_ID qo'shing, keyin redeploy qiling",
    });
  }

  let message = "";
  try {
    if (event.body) {
      if (event.isBase64Encoded) {
        const decoded = Buffer.from(event.body, "base64").toString("utf8");
        try {
          const body = JSON.parse(decoded);
          message = (body.message || body.text || "").toString().trim();
        } catch (_) {
          const params = new URLSearchParams(decoded);
          message = (params.get("message") || "").toString().trim();
        }
      } else {
        try {
          const body = JSON.parse(event.body);
          message = (body.message || body.text || "").toString().trim();
        } catch (_) {
          const params = new URLSearchParams(event.body);
          message = (params.get("message") || "").toString().trim();
        }
      }
    }
  } catch (e) {
    return json(400, { error: "Body parse error", details: String(e.message || e) });
  }

  if (!message) {
    return json(400, { error: "Message is empty" });
  }

  // Oddiy matn (escape muammosi bo'lmasin)
  const text =
    "💌 Munisa javobi\n\n" +
    message +
    "\n\n— saytdan";

  const payload = JSON.stringify({
    chat_id: chatId,
    text: text,
  });

  try {
    const result = await sendTelegram(token, payload);
    return json(200, { ok: true, telegram: result });
  } catch (err) {
    return json(502, {
      error: "Telegramga yuborib bo'lmadi",
      details: String(err.message || err),
    });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  };
}

function sendTelegram(token, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error("Telegram API " + res.statusCode + ": " + data));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
  