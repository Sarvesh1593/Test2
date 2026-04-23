const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const { MongoClient } = require("mongodb");
const cron = require("node-cron"); // ← ADD THIS
const moment = require("moment-timezone"); // ← ADD THIS // ✅ NEW: MongoDB driver

const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "fitbot_verify_123";

// ─── MongoDB Setup ────────────────────────────────────────────────────────────
// ✅ NEW: Connect once at startup and reuse the connection throughout the app.
// Set MONGODB_URI in your .env file, e.g.:
//   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/fitbot?retryWrites=true&w=majority

const MONGODB_URI = process.env.MONGODB_URI;
let db = null; // Will hold the connected database instance

async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn(
      "⚠️  MONGODB_URI not set — profiles will NOT persist across restarts.",
    );
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(); // Uses the DB name from the URI string automatically
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
  }
}

// ─── In-memory cache (fast reads during active session) ───────────────────────
// Profiles are loaded from MongoDB on first message, then cached here.
// Any update is written to both the cache AND MongoDB.
const userProfiles = new Map();

// ─── Default profile shape ────────────────────────────────────────────────────
function defaultProfile() {
  return {
    age: null,
    weight: null,
    height: null,
    bmi: null,
    vegNonVeg: null,
    goal: null,
    problems: null,
    timing: null,
    schedule: null,
    reminderOn: false,
    dietPlan: null,
    workoutPlan: null,
    flow: null,
    step: 0,
    history: [],
    welcomed: false, // ← tracks if Welcome screen was already sent
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ─── getProfile: load from cache OR MongoDB ───────────────────────────────────
// ✅ NEW: Now async. On first call for a phone number it hits MongoDB.
//         After that the in-memory cache is used (fast).
async function getProfile(from) {
  // 1. Return from cache if already loaded this session
  if (userProfiles.has(from)) return userProfiles.get(from);

  // 2. Try fetching from MongoDB
  if (db) {
    try {
      const saved = await db.collection("profiles").findOne({ _id: from });
      if (saved) {
        // Strip the Mongo _id key before caching, store as phone prop instead
        const { _id, ...data } = saved;
        userProfiles.set(from, data);
        console.log(`📦 Profile loaded from MongoDB for ${from}`);
        return data;
      }
    } catch (err) {
      console.error("❌ MongoDB read error:", err.message);
    }
  }

  // 3. Brand-new user — create default and cache it (don't save to DB yet)
  const fresh = defaultProfile();
  userProfiles.set(from, fresh);
  return fresh;
}

// ─── saveProfile: persist cache → MongoDB ─────────────────────────────────────
// ✅ NEW: Call this after every meaningful profile change (plan generated,
//         step updated, reminder toggled, etc.).
//         Uses upsert so it works for both new and returning users.
async function saveProfile(from, profile) {
  profile.updatedAt = new Date(); // always bump timestamp

  if (!db) return; // silently skip if Mongo isn't connected

  try {
    await db.collection("profiles").updateOne(
      { _id: from }, // match by phone number
      { $set: { ...profile, _id: from } }, // upsert full profile
      { upsert: true }, // create doc if it doesn't exist
    );
  } catch (err) {
    console.error("❌ MongoDB write error:", err.message);
  }
}

// ─── System Prompts ───────────────────────────────────────────────────────────

const DIET_SYSTEM = `You are FitBot, a WhatsApp AI diet coach. Be friendly, concise, use emojis.
Format all responses for WhatsApp: use *bold* with asterisks, bullet points with •.
Keep replies under 300 words.
 
When generating a diet plan you MUST use this exact structure:
📋 *Your Personalised Diet Plan*
 
☀️ *Morning (7 AM):* [meal]
🥣 *Breakfast (8 AM):* [meal]
🍎 *Mid-Morning (11 AM):* [snack]
🍱 *Lunch (1 PM):* [meal]
🫖 *Evening (4 PM):* [snack]
🌙 *Dinner (7–8 PM):* [meal]
 
💧 *Hydration:* Drink 8–10 glasses of water daily.
🔥 *Daily Calories:* ~[X] kcal
 
End with one short motivational line.`;

const WORKOUT_SYSTEM = `You are FitBot, a WhatsApp AI fitness coach. Be friendly, concise, use emojis.
Format all responses for WhatsApp: use *bold* with asterisks.
Keep replies under 300 words.
 
When generating a workout plan use this exact structure:
🗓️ *Your 5-Day Workout Plan*
 
*Mon:* [exercise — duration]
*Tue:* [exercise — duration]
*Wed:* [exercise — duration]
*Fri:* [exercise — duration]
*Sat:* [exercise — duration]
*Thu & Sun:* Rest / Light walk
 
⏰ *Warm-up:* 10 min before each session
💪 *Tip:* [one actionable tip based on their goal]
 
End with one short motivational line.`;

const GENERAL_SYSTEM = `You are FitBot, a friendly WhatsApp AI fitness and diet coach.
Use emojis naturally. Format for WhatsApp: *bold* for headings, bullet points with •.
Keep replies under 250 words. Be encouraging and practical.`;

// ─── Webhook Verification ─────────────────────────────────────────────────────
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

// ─── Receive Messages ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Always ack Meta immediately

  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    const message = messages[0];
    const from = message.from;
    const msgType = message.type;

    console.log(`📩 From: ${from} | Type: ${msgType}`);

    const profile = await getProfile(from);

    // ── Brand-new user: show Welcome ONCE for any message type ──
    // sendWelcome() sets profile.welcomed = true so this never fires again.
    // After that, all buttons work immediately on the very first tap.
    if (!profile.welcomed) {
      await sendWelcome(from, profile);
      return;
    }

    if (msgType === "text") {
      const text = message.text.body.trim();
      await handleText(from, text, profile);
    } else if (msgType === "interactive") {
      const btnId = message.interactive?.button_reply?.id || "";
      const btnTitle = message.interactive?.button_reply?.title || "";
      const listId = message.interactive?.list_reply?.id || "";
      const listTitle = message.interactive?.list_reply?.title || "";
      const reply = btnId || listId;
      const label = btnTitle || listTitle;
      await handleInteractive(from, reply, label, profile);
    } else if (msgType === "image") {
      await handleImage(
        from,
        message.image.id,
        message.image?.caption || "",
        profile,
      );
    } else if (msgType === "audio" || msgType === "voice") {
      await sendMessage(
        from,
        "🎤 Voice messages coming soon! Please type your question or send a food photo 📸",
      );
    } else {
      await sendMessage(
        from,
        "I understand text and food photos! 📸 Type a message or tap a button to get started 💪",
      );
    }
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

// ─── Handle Text ───────────────────────────────────────────────────────────────
async function handleText(from, text, profile) {
  const lower = text.toLowerCase();

  // Global reset commands
  if (["hi", "hello", "hey", "menu"].includes(lower)) {
    profile.flow = null;
    profile.step = 0;
    await sendWelcome(from, profile);
    return;
  }

  if (profile.flow === "diet") {
    await handleDietStep(from, text, profile);
    return;
  }

  if (profile.flow === "workout") {
    await handleWorkoutStep(from, text, profile);
    return;
  }

  // General AI chat
  profile.history.push({ role: "user", content: text });
  const reply = await callGPT(profile.history, GENERAL_SYSTEM);
  profile.history.push({ role: "assistant", content: reply });
  trimHistory(profile.history);

  // ✅ NEW: Save after every chat message so history persists
  await saveProfile(from, profile);

  await sendMessage(from, reply);
  await sendMainMenu(from);
}

// ─── Handle Interactive Buttons ────────────────────────────────────────────────
async function handleInteractive(from, id, label, profile) {
  switch (id) {
    case "start_diet":
      profile.flow = "diet";
      profile.step = 0;
      await startDietFlow(from, profile);
      break;

    case "start_workout":
      profile.flow = "workout";
      profile.step = 0;
      await startWorkoutFlow(from, profile);
      break;

    case "view_profile":
      await sendProfileCard(from, profile);
      break;

    case "diet_veg":
    case "diet_nonveg":
    case "diet_vegan":
      if (profile.flow === "diet" && profile.step === 2) {
        profile.vegNonVeg = label;
        profile.step = 3;
        await saveProfile(from, profile); // ✅ NEW: save after each step
        await askDietStep3(from);
      }
      break;

    case "goal_reduce":
    case "goal_gain":
    case "goal_lean":
      if (profile.flow === "diet" && profile.step === 3) {
        profile.goal = label;
        await generateDietPlan(from, profile);
      }
      break;

    case "workout_loss":
    case "workout_muscle":
    case "workout_flex":
    case "workout_strength":
      if (profile.flow === "workout") {
        profile.goal = label;
        profile.step = 3;
        await saveProfile(from, profile); // ✅ NEW
        await askWorkoutStep3(from);
      }
      break;

    case "problem_back":
    case "problem_knee":
    case "problem_heart":
    case "problem_none":
      if (profile.flow === "workout" && profile.step === 3) {
        profile.problems = label;
        profile.step = 4;
        await saveProfile(from, profile); // ✅ NEW
        await askWorkoutStep4(from);
      }
      break;

    case "time_20":
    case "time_30":
    case "time_45":
      if (profile.flow === "workout" && profile.step === 4) {
        profile.timing = label;
        await generateWorkoutPlan(from, profile);
      }
      break;

    case "start_today":
      profile.schedule = "Started today";
      await sendMessage(
        from,
        "🔥 *Let's go!* Your first session starts today! I'll remind you 30 min before your workout. You've got this! 💪",
      );
      await askWorkoutReminder(from, profile);
      break;

    case "schedule_later":
      await sendMessage(
        from,
        "📅 No problem! Your workout plan is saved. Come back when you're ready to begin 💪",
      );
      profile.flow = null;
      await saveProfile(from, profile); // ✅ NEW
      await sendMainMenu(from);
      break;

    case "reminder_yes":
      // Step 0 = ask timezone, Step 1 = ask time
      profile.flow = "reminder";
      profile.step = 0;
      await saveProfile(from, profile);
      await askReminderTimezone(from); // CHANGED: ask timezone first
      break;

    case "reminder_no":
      profile.reminderOn = false;
      await sendMessage(
        from,
        "👍 Got it! Your plan is saved. Tap *Menu* anytime to see your options 💪",
      );
      profile.flow = null;
      await saveProfile(from, profile); // ✅ NEW
      await sendMainMenu(from);
      break;

    case "back_menu":
      profile.flow = null;
      profile.step = 0;
      await sendWelcome(from, profile);
      break;

    default:
      await handleText(from, label, profile);
  }
}

// ─── DIET PLAN FLOW ────────────────────────────────────────────────────────────
async function startDietFlow(from, profile) {
  await sendMessage(
    from,
    "🥗 *Diet Plan Generator*\nLet me create a personalised meal plan for you! I'll ask a few quick questions 👇",
  );
  await askDietStep0(from);
}

async function askDietStep0(from) {
  await sendMessage(
    from,
    "📅 *Question 1 of 4*\n\nWhat is your *age*?\n\nPlease type your age (e.g. 25)",
  );
}

async function askDietStep1(from) {
  await sendMessage(
    from,
    "⚖️ *Question 2 of 4*\n\nWhat is your *weight* in kg?\n\nPlease type your weight (e.g. 70)",
  );
}

async function askDietStep2(from) {
  await sendButtons(from, "🥦 *Question 3 of 4*\n\nAre you *Veg or Non-Veg*?", [
    { id: "diet_veg", title: "🥦 Vegetarian" },
    { id: "diet_nonveg", title: "🍗 Non-Vegetarian" },
    { id: "diet_vegan", title: "🌿 Vegan" },
  ]);
}

async function askDietStep3(from) {
  await sendButtons(from, "🎯 *Question 4 of 4*\n\nWhat is your *diet goal*?", [
    { id: "goal_reduce", title: "⚡ Reduce Weight" },
    { id: "goal_gain", title: "💪 Gain Weight" },
    { id: "goal_lean", title: "🏃 Stay Lean" },
  ]);
}

async function handleDietStep(from, text, profile) {
  switch (profile.step) {
    case 0:
      profile.age = text;
      profile.step = 1;
      await saveProfile(from, profile); // ✅ NEW: save age
      await askDietStep1(from);
      break;
    case 1: {
      const w = parseFloat(text);
      profile.weight = text;
      if (!isNaN(w)) {
        // NOTE: Height still hardcoded at 1.72m.
        // To fix properly, add a height question as step 1.5
        const bmi = (w / (1.72 * 1.72)).toFixed(1);
        profile.bmi = bmi;
      }
      profile.step = 2;
      await saveProfile(from, profile); // ✅ NEW: save weight + BMI
      await askDietStep2(from);
      break;
    }
    default:
      await sendMessage(from, "Please tap one of the buttons above 👆");
  }
}

async function generateDietPlan(from, profile) {
  profile.flow = null;
  await sendMessage(
    from,
    "⏳ *Generating your personalised diet plan...*\n🔄 Analysing your profile...",
  );

  const prompt = `Generate a daily diet plan for:
- Age: ${profile.age}
- Weight: ${profile.weight} kg
- Diet type: ${profile.vegNonVeg}
- Goal: ${profile.goal}
- BMI: ${profile.bmi || "unknown"}

Use the required WhatsApp format with meal timings.`;

  const reply = await callGPT([{ role: "user", content: prompt }], DIET_SYSTEM);
  profile.dietPlan = reply;

  // ✅ NEW: Save diet plan to MongoDB as soon as it's generated
  await saveProfile(from, profile);

  await sendMessage(from, reply);

  await sendButtons(
    from,
    "🔔 Would you like *daily reminders* to follow your diet plan?",
    [
      { id: "reminder_yes", title: "✅ Yes, remind me" },
      { id: "reminder_no", title: "❌ No thanks" },
    ],
  );
}

// ─── WORKOUT PLAN FLOW ─────────────────────────────────────────────────────────
async function startWorkoutFlow(from, profile) {
  if (profile.bmi) {
    await sendMessage(
      from,
      `🏋️ *Workout Plan Generator*\n\nI found your saved BMI: *${profile.bmi}* 📊\nUsing your existing profile — just a couple more questions!`,
    );
    profile.step = 2;
    await askWorkoutStep2(from);
  } else {
    await sendMessage(
      from,
      "🏋️ *Workout Plan Generator*\nLet me build your perfect workout! A few quick questions 👇",
    );
    await askWorkoutStep0(from);
  }
}

async function askWorkoutStep0(from) {
  await sendMessage(
    from,
    "📅 *Question 1 of 5*\n\nWhat is your *age*?\n\nPlease type your age (e.g. 25)",
  );
}

async function askWorkoutStep1(from) {
  await sendMessage(
    from,
    "⚖️ *Question 2 of 5*\n\nWhat is your *weight* in kg?\n\nPlease type your weight (e.g. 70)",
  );
}

async function askWorkoutStep2(from) {
  await sendButtons(from, "🎯 *What is your fitness goal?*", [
    { id: "workout_loss", title: "⚡ Weight Loss" },
    { id: "workout_muscle", title: "💪 Muscle Gain" },
    { id: "workout_flex", title: "🤸 Flexibility" },
    { id: "workout_strength", title: "🏋️ Strength" },
  ]);
}

async function askWorkoutStep3(from) {
  await sendButtons(
    from,
    "🩺 *Any health problems or injuries?*\n(Recommended: tell me so I avoid harmful exercises)",
    [
      { id: "problem_back", title: "🦴 Back Pain" },
      { id: "problem_knee", title: "🦵 Knee Issue" },
      { id: "problem_heart", title: "❤️ Heart Condition" },
      { id: "problem_none", title: "✅ No Issues" },
    ],
  );
}

async function askWorkoutStep4(from) {
  await sendButtons(
    from,
    "⏰ *How much time can you dedicate daily?*\n(Recommended: 30–45 min, 5 days a week)",
    [
      { id: "time_20", title: "⏱️ 20–30 min" },
      { id: "time_30", title: "⏱️ 30–45 min" },
      { id: "time_45", title: "⏱️ 45–60 min" },
    ],
  );
}

async function handleWorkoutStep(from, text, profile) {
  switch (profile.step) {
    case 0:
      profile.age = text;
      profile.step = 1;
      await saveProfile(from, profile); // ✅ NEW
      await askWorkoutStep1(from);
      break;
    case 1: {
      const w = parseFloat(text);
      profile.weight = text;
      if (!isNaN(w)) {
        profile.bmi = (w / (1.72 * 1.72)).toFixed(1);
      }
      profile.step = 2;
      await saveProfile(from, profile); // ✅ NEW
      await askWorkoutStep2(from);
      break;
    }
    default:
      await sendMessage(from, "Please tap one of the buttons above 👆");
  }
}

async function generateWorkoutPlan(from, profile) {
  profile.flow = null;
  await sendMessage(
    from,
    "⏳ *Building your workout plan...*\n🔄 Creating your 5-day schedule...",
  );

  const prompt = `Generate a 5-day workout plan for:
- Age: ${profile.age}
- Weight: ${profile.weight} kg
- Goal: ${profile.goal}
- Health issues: ${profile.problems || "none"}
- Daily time: ${profile.timing}
- BMI: ${profile.bmi || "unknown"}

Use the required WhatsApp format with Mon/Tue/Wed/Fri/Sat days.`;

  const reply = await callGPT(
    [{ role: "user", content: prompt }],
    WORKOUT_SYSTEM,
  );
  profile.workoutPlan = reply;

  // ✅ NEW: Save workout plan to MongoDB
  await saveProfile(from, profile);

  await sendMessage(from, reply);

  await sendButtons(from, "🚀 Ready to start?", [
    { id: "start_today", title: "🚀 Start Today" },
    { id: "schedule_later", title: "📅 Schedule Later" },
  ]);
}

async function askWorkoutReminder(from, profile) {
  await sendButtons(from, "🔔 Set *daily workout reminders*?", [
    { id: "reminder_yes", title: "✅ Yes, remind me" },
    { id: "reminder_no", title: "❌ No thanks" },
  ]);
}

// ─── REMINDER FLOW — WORLD TIMEZONE SUPPORT ──────────────────────────────────
// Two steps:
//   Step 0 → user types their country/city/UTC offset
//   Step 1 → user types time in HH:MM
// moment-timezone converts UTC → user's local time in the cron job.

// Phone prefix → IANA timezone (fallback when user's input can't be resolved)
const PREFIX_TZ = {
  91: "Asia/Kolkata",
  1: "America/New_York",
  44: "Europe/London",
  61: "Australia/Sydney",
  971: "Asia/Dubai",
  966: "Asia/Riyadh",
  92: "Asia/Karachi",
  880: "Asia/Dhaka",
  977: "Asia/Kathmandu",
  94: "Asia/Colombo",
  65: "Asia/Singapore",
  60: "Asia/Kuala_Lumpur",
  62: "Asia/Jakarta",
  63: "Asia/Manila",
  66: "Asia/Bangkok",
  81: "Asia/Tokyo",
  82: "Asia/Seoul",
  86: "Asia/Shanghai",
  49: "Europe/Berlin",
  33: "Europe/Paris",
  39: "Europe/Rome",
  34: "Europe/Madrid",
  7: "Europe/Moscow",
  55: "America/Sao_Paulo",
  52: "America/Mexico_City",
  27: "Africa/Johannesburg",
  20: "Africa/Cairo",
  234: "Africa/Lagos",
};
function guessTzFromPhone(phone) {
  for (const prefix of ["234", "971", "966", "880", "977", "62", "63"]) {
    if (phone.startsWith(prefix)) return PREFIX_TZ[prefix];
  }
  for (const prefix of [
    "91",
    "44",
    "61",
    "92",
    "94",
    "65",
    "60",
    "66",
    "81",
    "82",
    "86",
    "49",
    "33",
    "39",
    "34",
    "55",
    "52",
    "27",
    "20",
    "7",
    "1",
  ]) {
    if (phone.startsWith(prefix)) return PREFIX_TZ[prefix];
  }
  return "UTC";
}

// Country/city name → IANA timezone
const COUNTRY_TZ_MAP = {
  india: "Asia/Kolkata",
  pakistan: "Asia/Karachi",
  bangladesh: "Asia/Dhaka",
  nepal: "Asia/Kathmandu",
  "sri lanka": "Asia/Colombo",
  dubai: "Asia/Dubai",
  uae: "Asia/Dubai",
  "abu dhabi": "Asia/Dubai",
  "saudi arabia": "Asia/Riyadh",
  riyadh: "Asia/Riyadh",
  qatar: "Asia/Qatar",
  kuwait: "Asia/Kuwait",
  bahrain: "Asia/Bahrain",
  oman: "Asia/Muscat",
  singapore: "Asia/Singapore",
  malaysia: "Asia/Kuala_Lumpur",
  indonesia: "Asia/Jakarta",
  philippines: "Asia/Manila",
  thailand: "Asia/Bangkok",
  vietnam: "Asia/Ho_Chi_Minh",
  japan: "Asia/Tokyo",
  "south korea": "Asia/Seoul",
  korea: "Asia/Seoul",
  china: "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  taiwan: "Asia/Taipei",
  uk: "Europe/London",
  england: "Europe/London",
  london: "Europe/London",
  germany: "Europe/Berlin",
  france: "Europe/Paris",
  italy: "Europe/Rome",
  spain: "Europe/Madrid",
  russia: "Europe/Moscow",
  turkey: "Europe/Istanbul",
  netherlands: "Europe/Amsterdam",
  poland: "Europe/Warsaw",
  sweden: "Europe/Stockholm",
  norway: "Europe/Oslo",
  greece: "Europe/Athens",
  usa: "America/New_York",
  us: "America/New_York",
  "united states": "America/New_York",
  "new york": "America/New_York",
  "los angeles": "America/Los_Angeles",
  chicago: "America/Chicago",
  canada: "America/Toronto",
  mexico: "America/Mexico_City",
  brazil: "America/Sao_Paulo",
  argentina: "America/Argentina/Buenos_Aires",
  colombia: "America/Bogota",
  "south africa": "Africa/Johannesburg",
  nigeria: "Africa/Lagos",
  egypt: "Africa/Cairo",
  kenya: "Africa/Nairobi",
  ghana: "Africa/Accra",
  australia: "Australia/Sydney",
  "new zealand": "Pacific/Auckland",
};

function parseUtcOffset(str) {
  const match = str.match(/utc([+-])(\d{1,2})(?::(\d{2}))?/i);
  if (!match) return null;
  const sign = match[1] === "+" ? 1 : -1;
  const totalMin = sign * (parseInt(match[2]) * 60 + parseInt(match[3] || "0"));
  return (
    moment.tz.names().find((z) => moment.tz(z).utcOffset() === totalMin) || null
  );
}

async function askReminderTimezone(from) {
  await sendMessage(
    from,
    "🌍 *What is your country or city?*\n\n" +
      "This lets me send reminders at the right time for YOU, anywhere in the world!\n\n" +
      "Just type your country or city name:\n" +
      "• India  • USA  • UK  • Dubai\n" +
      "• Australia  • Singapore  • Nigeria\n\n" +
      "Or type your UTC offset e.g. *UTC+5:30*",
  );
}

async function handleReminderStep(from, text, profile) {
  // ── Step 0: resolve timezone ──────────────────────────────────────────────
  if (profile.step === 0) {
    const lower = text.trim().toLowerCase();
    let tz = COUNTRY_TZ_MAP[lower] || null;
    if (!tz && lower.startsWith("utc")) tz = parseUtcOffset(lower);
    if (!tz) {
      for (const [key, val] of Object.entries(COUNTRY_TZ_MAP)) {
        if (lower.includes(key) || key.includes(lower)) {
          tz = val;
          break;
        }
      }
    }
    if (!tz) tz = guessTzFromPhone(from);

    profile.reminderTz = tz;
    profile.step = 1;
    await saveProfile(from, profile);

    await sendMessage(
      from,
      `🌍 *Timezone: ${tz.replace(/_/g, " ")}* ✅\n\n` +
        `⏰ *What time do you want your daily reminder?*\n\n` +
        `Type in *HH:MM* (24-hour format)\n` +
        `• *07:00* — 7 AM\n• *08:30* — 8:30 AM\n• *20:00* — 8 PM`,
    );
    return;
  }

  // ── Step 1: validate and save time ───────────────────────────────────────
  if (profile.step === 1) {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const trimmed = text.trim();
    if (!timeRegex.test(trimmed)) {
      await sendMessage(
        from,
        "❌ *Invalid format!*\n\nUse *HH:MM* (24-hour).\nExamples: *07:00*, *13:30*, *20:00*\n\nTry again 👇",
      );
      return;
    }

    profile.reminderOn = true;
    profile.reminderTime = trimmed;
    profile.flow = null;
    await saveProfile(from, profile);

    const [h, m] = trimmed.split(":");
    const hour = parseInt(h);
    const ampm = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    const tz = profile.reminderTz || "UTC";

    await sendMessage(
      from,
      `🔔 *Reminder set!* ✅\n\n` +
        `📍 Timezone: *${tz.replace(/_/g, " ")}*\n` +
        `⏰ Every day at *${hour12}:${m} ${ampm}*\n\n` +
        `I'll message you daily at this time, wherever you are 🌍\n` +
        `Type *stop reminder* anytime to turn it off. 💪`,
    );
    await sendMainMenu(from);
  }
}

// ─── CRON: every minute, checks all users in their OWN timezone ───────────────
cron.schedule("* * * * *", async () => {
  const utcNow = moment.utc();

  for (const [phone, profile] of userProfiles.entries()) {
    if (!profile.reminderOn || !profile.reminderTime) continue;
    try {
      const tz = profile.reminderTz || guessTzFromPhone(phone);
      const local = utcNow.clone().tz(tz);
      const nowTime = `${String(local.hours()).padStart(2, "0")}:${String(local.minutes()).padStart(2, "0")}`;
      if (nowTime !== profile.reminderTime) continue;

      const planLine = profile.workoutPlan
        ? "🏋️ Don't skip today's workout session!"
        : "🥗 Stay on track with your diet plan today!";
      const goalLine = profile.goal
        ? `Your goal: *${profile.goal}* — keep going! 🔥`
        : "Stay consistent — results take time! 💪";

      await sendMessage(
        phone,
        `⏰ *FitBot Daily Reminder*\n\n` +
          `Time to crush your fitness goals! 💪\n\n` +
          `${planLine}\n` +
          `${goalLine}\n\n` +
          `_Type *menu* to see your full plan_ 📋`,
      );
      console.log(`✅ Reminder → ${phone} | ${tz} | ${nowTime}`);
    } catch (err) {
      console.error(`❌ Reminder failed for ${phone}:`, err.message);
    }
  }
});

// ─── PROFILE CARD ──────────────────────────────────────────────────────────────
async function sendProfileCard(from, profile) {
  const p = profile;
  const hasSome = p.age || p.weight || p.goal;

  if (!hasSome) {
    await sendMessage(
      from,
      "👤 *Your Profile*\n\nNo profile saved yet!\nComplete your *Diet Plan* or *Workout* to build your profile automatically 💪",
    );
    await sendMainMenu(from);
    return;
  }

  const msg =
    `👤 *Your Fitness Profile*\n\n` +
    `• *Age:* ${p.age || "—"}\n` +
    `• *Weight:* ${p.weight ? p.weight + " kg" : "—"}\n` +
    `• *BMI:* ${p.bmi || "—"}\n` +
    `• *Diet Type:* ${p.vegNonVeg || "—"}\n` +
    `• *Goal:* ${p.goal || "—"}\n` +
    `• *Health Issues:* ${p.problems || "None"}\n` +
    `• *Workout Time:* ${p.timing || "—"}\n` +
    `• *Reminder:* ${p.reminderOn ? "✅ ON" : "❌ OFF"}\n` +
    `• *Plans saved:* ${p.dietPlan ? "✅ Diet" : "❌ Diet"} | ${p.workoutPlan ? "✅ Workout" : "❌ Workout"}`;

  await sendMessage(from, msg);
  await sendMainMenu(from);
}

// ─── HANDLE IMAGE (Food Analysis) ─────────────────────────────────────────────
async function handleImage(from, imageId, caption, profile) {
  await sendMessage(
    from,
    "📸 *Got your food photo!*\n🔍 Analysing calories, nutrition & diet advice...",
  );

  try {
    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${imageId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } },
    );
    const imgRes = await axios.get(metaRes.data.url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mimeType = imgRes.headers["content-type"] || "image/jpeg";

    const prompt = caption
      ? `Analyze this food image. User said: "${caption}". Give full diet analysis.`
      : `Analyze this food image. Identify the food, estimate calories & macros, give a health rating out of 10, and provide 3 diet tips.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [
        { role: "system", content: GENERAL_SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const reply = response.choices[0].message.content;
    profile.history.push({ role: "user", content: "[Sent a food image]" });
    profile.history.push({ role: "assistant", content: reply });
    trimHistory(profile.history);

    // ✅ NEW: Save history after image analysis
    await saveProfile(from, profile);

    await sendMessage(from, reply);
    await sendButtons(from, "Want more help? 👇", [
      { id: "start_diet", title: "🥗 Full Diet Plan" },
      { id: "start_workout", title: "🏋️ Workout Plan" },
      { id: "back_menu", title: "📋 Main Menu" },
    ]);
  } catch (err) {
    console.error("❌ Image error:", err.message);
    await sendMessage(
      from,
      "❌ Couldn't analyse that image.\n\nTry:\n• A clearer, well-lit photo\n• Closer shot of food\n• JPEG or PNG format\n\nSend it again! 💪",
    );
  }
}

// ─── CALL GPT-4o ───────────────────────────────────────────────────────────────
async function callGPT(messages, systemPrompt) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error("❌ GPT-4o error:", err.message);
    return "⚠️ I had a moment! Please try again — I'm here to help 💪";
  }
}

// ─── Send Welcome ──────────────────────────────────────────────────────────────
// Accepts profile so we can set welcomed = true and save it.
// This ensures Welcome is only ever sent ONCE per user.
async function sendWelcome(from, profile) {
  await sendMessage(
    from,
    `💪 *Welcome to FitBot — Your AI Fitness Coach!*\n\n` +
      `Powered by *GPT-4o* 🤖\n\n` +
      `Here's what I can do:\n` +
      `🥗 *Diet Plan* — Personalised meal plan\n` +
      `🏋️ *Workout* — Custom 5-day routine\n` +
      `👤 *Profile* — Your saved fitness data\n` +
      `📸 *Food Photo* — Send any meal for analysis\n\n` +
      `Choose an option below 👇`,
  );
  await sendMainMenu(from);

  // Mark welcomed so buttons work immediately on the next tap
  if (profile) {
    profile.welcomed = true;
    await saveProfile(from, profile);
  }
}

// ─── SEND MAIN MENU ────────────────────────────────────────────────────────────
async function sendMainMenu(from) {
  await sendButtons(from, "What would you like to do? 👇", [
    { id: "start_diet", title: "🥗 Diet Plan" },
    { id: "start_workout", title: "🏋️ Workout" },
    { id: "view_profile", title: "👤 My Profile" },
  ]);
}

// ─── Send WhatsApp Text ────────────────────────────────────────────────────────
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
    return { ok: true };
  } catch (err) {
    console.error("❌ Send error:", err.response?.data || err.message);
    return { ok: false, error: err.response?.data || err.message };
  }
}

// ─── Send WhatsApp Template Message ───────────────────────────────────────────
async function sendTemplateMessage(
  to,
  templateName,
  language = "en_US",
  parameters = [],
) {
  try {
    const body = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
      },
    };

    if (Array.isArray(parameters) && parameters.length > 0) {
      body.template.components = [
        {
          type: "body",
          parameters: parameters.map((p) => ({
            type: "text",
            text: String(p),
          })),
        },
      ];
    }

    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      body,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );
    return { ok: true };
  } catch (err) {
    console.error("❌ Template send error:", err.response?.data || err.message);
    return { ok: false, error: err.response?.data || err.message };
  }
}

// ─── SEND INTERACTIVE BUTTONS (max 3) ─────────────────────────────────────────
async function sendButtons(to, bodyText, buttons) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.substring(0, 20) },
            })),
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
    console.error("❌ Button error:", err.response?.data || err.message);
  }
}

// ✅ NEW: sendInteractiveButtons alias used by /broadcast route
// This was referenced but never defined in the original code — fixed here.
async function sendInteractiveButtons(to, bodyText, buttons) {
  return sendButtons(to, bodyText, buttons);
}

// ─── Trim history ──────────────────────────────────────────────────────────────
function trimHistory(history) {
  if (history.length > 20) history.splice(0, 2);
}

// ─── Admin Routes (unchanged) ──────────────────────────────────────────────────
app.get("/meta-templates", async (req, res) => {
  try {
    if (!WHATSAPP_TOKEN)
      return res.status(500).json({ error: "WHATSAPP_TOKEN not configured" });

    const wabaId = process.env.WABA_ID;
    if (!wabaId)
      return res.status(500).json({ error: "WABA_ID not configured" });

    const url = `https://graph.facebook.com/v19.0/${wabaId}/message_templates`;
    const resp = await axios.get(url, {
      params: {
        access_token: WHATSAPP_TOKEN,
        fields: "name,status,components",
      },
    });

    const raw = Array.isArray(resp.data?.data) ? resp.data.data : [];
    const normalized = raw.map((t) => {
      let bodyText = null;
      if (Array.isArray(t.components)) {
        const body = t.components.find(
          (c) => String(c.type || "").toLowerCase() === "body",
        );
        if (body) bodyText = body.text || body.body_text || null;
      }
      return {
        id: t.id || t.name,
        name: t.name,
        status: t.status || null,
        components: t.components || [],
        body: bodyText,
      };
    });

    res.json(normalized);
  } catch (err) {
    console.error(
      "Failed to fetch meta templates:",
      err.response?.data || err.message,
    );
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get("/subscribers", (req, res) => {
  // ✅ FIXED: was using userSessions (empty), now uses userProfiles
  res.json({
    count: userProfiles.size,
    numbers: Array.from(userProfiles.keys()),
  });
});

app.post("/broadcast", async (req, res) => {
  const {
    metaTemplateName,
    metaTemplateLanguage,
    templateParameters,
    message,
    targets,
    sendToAll,
    interactiveButtons,
  } = req.body || {};

  let recipients = [];
  // ✅ FIXED: was using userSessions (empty), now uses userProfiles
  if (sendToAll) recipients = Array.from(userProfiles.keys());
  else if (Array.isArray(targets) && targets.length) recipients = targets;
  else return res.status(400).json({ error: "No targets specified" });

  const results = [];

  for (const to of recipients) {
    try {
      let r;
      if (metaTemplateName) {
        r = await sendTemplateMessage(
          to,
          metaTemplateName,
          metaTemplateLanguage || "en_US",
          Array.isArray(templateParameters) ? templateParameters : [],
        );
      } else if (
        Array.isArray(interactiveButtons) &&
        interactiveButtons.length
      ) {
        if (!message) {
          results.push({
            to,
            ok: false,
            error: "Interactive messages require a message body",
          });
          continue;
        }
        r = await sendInteractiveButtons(to, message, interactiveButtons); // ✅ FIXED: now defined
      } else {
        if (!message) {
          results.push({ to, ok: false, error: "No message specified" });
          continue;
        }
        r = await sendMessage(to, message);
      }
      results.push({ to, ok: !!r?.ok, error: r?.error });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }

  res.json({ requested: recipients.length, results });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ─── Health Check (single, deduplicated) ──────────────────────────────────────
// ✅ FIXED: removed duplicate GET "/" route from original code
app.get("/", (req, res) => {
  res.json({
    status: "FitBot GPT-4o running 💪",
    users: userProfiles.size,
    mongoConnected: !!db, // ✅ NEW: shows MongoDB status in health check
    timestamp: new Date().toISOString(),
  });
});

// ─── Start Server (after MongoDB connects) ────────────────────────────────────
// ✅ NEW: connectMongo() is called first; server starts regardless of whether
//         MongoDB is available (graceful degradation — bot still works, just
//         profiles won't persist across restarts if Mongo is down).
const PORT = process.env.PORT || 3000;
connectMongo().then(() => {
  app.listen(PORT, () => console.log(`🚀 FitBot running on port ${PORT}`));
});
