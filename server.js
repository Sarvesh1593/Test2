const express = require("express");
const axios = require("axios");
const { HfInference } = require("@huggingface/inference");
// const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());

// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "fitbot_verify_123";

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are FitBot, a friendly and expert WhatsApp AI fitness and diet coach.

Your tone: motivating, warm, concise, practical. Use emojis naturally.
Format for WhatsApp: use *bold* for headings, numbered lists, keep under 350 words.

You can help with:
- Food image analysis with full diet advice
- Personalized diet plans
- Workout routines
- BMI and calorie calculations
- Hydration and supplement tips

When analyzing a food image, always follow this exact structure:
1. *What I see* — identify the food/meal clearly
2. *Nutrition estimate* — calories, protein, carbs, fats
3. *Health rating* — X/10 with one-line reason
4. *Is this good for your diet?* — honest assessment
5. *Diet advice* — specific tips based on this meal (what to add, remove, or swap)
6. *Better alternatives* — 2-3 healthier swaps or additions
7. *Today's diet tip* — one actionable tip based on what they ate

Always end with an encouraging message.`;

// ─── Image-Specific Prompt ─────────────────────────────────────────────────
const IMAGE_DIET_PROMPT = `Analyze this food image and provide a complete diet response.

Structure your reply exactly like this:

📸 *Food Identified:* [name of food/meal]

🔢 *Nutrition Estimate (per serving):*
• Calories: ~XXX kcal
• Protein: ~Xg
• Carbs: ~Xg
• Fats: ~Xg

⭐ *Health Rating:* X/10 — [one-line reason]

✅ *Diet Assessment:*
[2-3 sentences — is this good, bad, or okay for general health/weight goals?]

💡 *Diet Advice for This Meal:*
1. [Specific tip 1]
2. [Specific tip 2]
3. [Specific tip 3]

🔄 *Healthier Alternatives:*
• [Swap 1]
• [Swap 2]

🌟 *Today's Diet Tip:*
[One actionable diet tip inspired by this meal]

Keep it under 300 words. Be encouraging at the end!`;

// ─── In-memory user sessions ──────────────────────────────────────────────
const userSessions = new Map();

// ─── Webhook Verification ─────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Receive Messages ─────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    const message = messages[0];
    const from = message.from;
    const msgType = message.type;

    console.log(`📩 From: ${from} | Type: ${msgType}`);

    if (!userSessions.has(from)) {
      userSessions.set(from, []);
      await sendWelcome(from);
      return;
    }

    const history = userSessions.get(from);

    if (msgType === "text") {
      await handleText(from, message.text.body, history);
    } else if (msgType === "image") {
      await handleImage(
        from,
        message.image.id,
        message.image?.caption || "",
        history,
      );
    } else if (msgType === "interactive") {
      const btnTitle = message.interactive?.button_reply?.title || "";
      await handleText(from, btnTitle, history);
    } else if (msgType === "audio" || msgType === "voice") {
      await sendMessage(
        from,
        "🎤 Voice messages coming soon! Please type your question or send a food photo 📸",
      );
    } else {
      await sendMessage(
        from,
        "I understand text messages and food photos! 📸 Send me a photo of any meal and I'll analyze it for you. 💪",
      );
    }
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

// ─── Handle Text ──────────────────────────────────────────────────────────
async function handleText(from, text, history) {
  // Start fresh chat when user types "hello"
  if (
    text.toLowerCase() === "hello" ||
    text.toLowerCase() === "hi" ||
    text.toLowerCase() === "hey" ||
    text.toLowerCase() === "Hello"
  ) {
    history = [];
  }

  history.push({ role: "user", content: text });
  const reply = await callGenAI(history);
  history.push({ role: "assistant", content: reply });
  trimHistory(history);
  await sendMessage(from, reply);

  if (history.length === 2) await sendQuickReplies(from);
}

// ─── Handle Image → Full Diet Analysis ───────────────────────────────────
async function handleImage(from, imageId, caption, history) {
  // Step 1: Tell user we're analyzing
  await sendMessage(
    from,
    "📸 Got your food photo! Analyzing it for you...\n\n🔍 Checking calories, nutrition & diet advice...",
  );

  try {
    // Step 2: Get image URL from Meta
    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${imageId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } },
    );

    // Step 3: Download image as Base64
    const imgRes = await axios.get(metaRes.data.url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mimeType = imgRes.headers["content-type"] || "image/jpeg";

    // Step 4: Build prompt — use caption if provided, else use full diet prompt
    const userText = caption
      ? `${IMAGE_DIET_PROMPT}\n\nUser also said: "${caption}"`
      : IMAGE_DIET_PROMPT;

    // Step 5: Add to session history with image
    const imageMessage = {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType, data: base64 },
        },
        { type: "text", text: userText },
      ],
    };
    history.push(imageMessage);

    // Step 6: Call Claude with vision
    const reply = await callGenAI(history);
    history.push({ role: "assistant", content: reply });
    trimHistory(history);

    // Step 7: Send full diet analysis back
    await sendMessage(from, reply);

    // Step 8: Follow-up quick actions after image analysis
    await sendImageFollowUp(from);
  } catch (err) {
    console.error("❌ Image error:", err.message);
    await sendMessage(
      from,
      "❌ Sorry, I couldn't read that image clearly.\n\n" +
        "Please try:\n• A clearer, well-lit photo\n• Closer shot of the food\n• JPEG or PNG format\n\nSend it again and I'll analyze it! 💪",
    );
  }
}

// ─── Call Gemini AI ───────────────────────────────────────────────────────
// async function callGenAI(history) {
//   try {
//     const model = genAI.getGenerativeModel({
//       model: "gemini-2.0-flash",
//     });

//     // Convert Anthropic format to Gemini format
//     const contents = history.map((msg) => ({
//       role: msg.role === "user" ? "user" : "model",
//       parts: Array.isArray(msg.content)
//         ? msg.content.map((part) =>
//             part.type === "image"
//               ? {
//                   inlineData: {
//                     mimeType: part.source.media_type,
//                     data: part.source.data,
//                   },
//                 }
//               : { text: part.text },
//           )
//         : [{ text: msg.content }],
//     }));

//     const response = await model.generateContent({
//       systemInstruction: SYSTEM_PROMPT,
//       contents: contents,
//     });

//     return response.response.text();
//   } catch (err) {
//     console.error("❌ Gemini error:", err.message);
//     return `⚠️ I had a moment! Please try again — I'm here to help 💪 ${err.message}`;
//   }
// }

async function callGenAI(history) {
  try {
    // Convert history to a text prompt
    let prompt = SYSTEM_PROMPT + "\n\n";
    history.forEach((msg) => {
      prompt += `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}\n`;
    });

    const response = await hf.textGeneration({
      model: "google/flan-t5-large",
      inputs: prompt,
      parameters: { max_new_tokens: 500 },
    });

    return response.generated_text;
  } catch (err) {
    console.error("❌ Hugging Face error:", err.message);
    return `⚠️ I had a moment! Please try again — I'm here to help 💪 ${err.message}`;
  }
}
// ─── Send WhatsApp Text ───────────────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("❌ Send error:", err.response?.data || err.message);
  }
}

// ─── Welcome Message ──────────────────────────────────────────────────────
async function sendWelcome(to) {
  const msg =
    `💪 *Welcome to FitBot — Your AI Diet & Fitness Coach!*\n\n` +
    `Here's what I can do:\n\n` +
    `📸 *Send any food photo* → I'll analyze it and give you:\n` +
    `   • Calories & macros\n` +
    `   • Health rating\n` +
    `   • Full diet advice\n` +
    `   • Healthier alternatives\n\n` +
    `💬 *Or type a question:*\n` +
    `   • "Give me a 7-day diet plan"\n` +
    `   • "Create a workout for weight loss"\n` +
    `   • "Calculate my BMI"\n\n` +
    `Let's start — send me a photo of your meal! 🍽️`;
  await sendMessage(to, msg);
  await sendQuickReplies(to);
}

// ─── Quick Reply Buttons (initial) ────────────────────────────────────────
async function sendQuickReplies(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: "What would you like help with? 👇" },
          action: {
            buttons: [
              {
                type: "reply",
                reply: { id: "diet_plan", title: "🥗 Diet Plan" },
              },
              {
                type: "reply",
                reply: { id: "workout", title: "🏋️ Workout Plan" },
              },
              { type: "reply", reply: { id: "bmi", title: "⚖️ My BMI" } },
            ],
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("❌ Quick reply error:", err.response?.data || err.message);
  }
}

// ─── Follow-up After Image Analysis ──────────────────────────────────────
async function sendImageFollowUp(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: "Want more help based on this meal? 👇" },
          action: {
            buttons: [
              {
                type: "reply",
                reply: { id: "full_diet", title: "🥗 Full Day Diet" },
              },
              {
                type: "reply",
                reply: { id: "calories", title: "🔥 My Calorie Goal" },
              },
              {
                type: "reply",
                reply: { id: "another_photo", title: "📸 Analyze Another" },
              },
            ],
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("❌ Follow-up error:", err.response?.data || err.message);
  }
}

// ─── Trim history (keep last 20 messages) ────────────────────────────────
function trimHistory(history) {
  if (history.length > 20) history.splice(0, 2);
}

// ─── Health check ─────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "FitBot running 💪",
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 FitBot running on port ${PORT}`));
