import fetch from "node-fetch";
import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 紐⑤뱺 ?붿껌 濡쒓렇 李띻린 (以묒슂)
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// ===============================
// ?섍꼍蹂??// ===============================
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  GH_TOKEN,
  GH_OWNER,
  GH_REPO,
  PORT
} = process.env;
const REPORT_ROW_LIMIT = 500;

// ===============================
// Supabase ?곌껐
// ===============================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===============================
// GitHub ?낆꽌???⑥닔
// ===============================
async function upsertToGitHub(path, contentText, message) {
  if (!GH_TOKEN || !GH_OWNER || !GH_REPO) {
    console.log("[GH] Missing env vars, skip GitHub update");
    return;
  }

  console.log("[GH] about to update GitHub");

  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;

  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "telegram-invest-server"
  };

  try {
    // 湲곗〈 ?뚯씪 SHA ?뺤씤
    let sha = null;
    const getRes = await fetch(api, { headers });

    if (getRes.status === 200) {
      const j = await getRes.json();
      sha = j.sha;
    } else if (getRes.status !== 404) {
      const t = await getRes.text();
      console.error("[GH] GET failed:", getRes.status, t);
      throw new Error(`[GH] GET failed: ${getRes.status} ${t}`);
    }

    const body = {
      message,
      content: Buffer.from(contentText, "utf8").toString("base64"),
      ...(sha ? { sha } : {})
    };

    const putRes = await fetch(api, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    // ?뚯뒪?몄슜
    if (![200, 201].includes(putRes.status)) {
      const t = await putRes.text();
      console.error("[GH] PUT failed:", putRes.status, t);
      throw new Error(`[GH] PUT failed: ${putRes.status} ${t}`);
    } else {
      console.log("[GH] file updated:", path);
    }

  } catch (err) {
    console.error("[GH] error:", err);
    throw err;
  }
}

function normalizeMonthKey(year, month) {
  const yyyy = String(year || "").trim();
  const mm = String(month || "").padStart(2, "0").trim();
  if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(mm)) {
    throw new Error("Invalid year/month");
  }
  return `${yyyy}-${mm}`;
}

function extractRowMonthKey(row) {
  const raw = row?.raw_message || "";
  const rawDateMatch = raw.match(/(\d{2})\/(\d{2})일\s+(\d{2}:\d{2})/);
  const baseYear = String(row?.date || "").slice(0, 4);
  if (rawDateMatch && /^\d{4}$/.test(baseYear)) {
    const d = new Date(Number(baseYear), Number(rawDateMatch[1]) - 1, Number(rawDateMatch[2]));
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  const rowDate = String(row?.date || "");
  return /^\d{4}-\d{2}/.test(rowDate) ? rowDate.slice(0, 7) : null;
}

async function fetchDailyRecordRows(limit = REPORT_ROW_LIMIT) {
  const { data, error } = await supabase
    .from("daily_records")
    .select("date, raw_message, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[SUPABASE] select error:", error);
    throw error;
  }

  return data || [];
}

async function fetchAllDailyRecordRows() {
  const batchSize = 1000;
  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("daily_records")
      .select("date, raw_message, created_at")
      .order("created_at", { ascending: false })
      .range(from, from + batchSize - 1);

    if (error) {
      console.error("[SUPABASE] full select error:", error);
      throw error;
    }

    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < batchSize) break;
    from += batchSize;
  }

  return rows;
}

async function fetchArchiveIndexFromGitHub() {
  if (!GH_TOKEN || !GH_OWNER || !GH_REPO) return [];

  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/data/archive`;
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "telegram-invest-server"
  };

  const res = await fetch(api, { headers });
  if (res.status === 404) return [];
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`[GH] archive index failed: ${res.status} ${text}`);
  }

  const items = await res.json();
  return (Array.isArray(items) ? items : [])
    .map(item => item?.name || "")
    .filter(name => /^\d{4}-\d{2}\.json$/.test(name))
    .map(name => name.replace(/\.json$/, ""))
    .sort();
}

async function doesGitHubFileExist(path) {
  if (!GH_TOKEN || !GH_OWNER || !GH_REPO) return false;

  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "telegram-invest-server"
  };

  const res = await fetch(api, { headers });
  if (res.status === 200) return true;
  if (res.status === 404) return false;

  const text = await res.text();
  throw new Error(`[GH] file exists check failed: ${res.status} ${text}`);
}

async function rebuildReportJson(reason = "manual") {
  const rows = await fetchDailyRecordRows(REPORT_ROW_LIMIT);

  const latestDate = rows?.[0]?.date || null;
  console.log("[REPORT] rebuild rows:", rows?.length || 0, "latest:", latestDate, "reason:", reason);

  const report = { ok: true, rows };
  await upsertToGitHub(
    "data/report.json",
    JSON.stringify(report, null, 2),
    `rebuild report ${latestDate || new Date().toISOString().slice(0, 10)}`
  );

  return { rowCount: rows?.length || 0, latestDate };
}

// ===============================
// 湲곕낯 ?뚯뒪??// ===============================
app.get("/", (req, res) => {
  res.send("?쒕쾭 ?댁븘?덉쓬");
});

// ===============================
// 由ы룷??議고쉶 API (理쒓렐 50媛?湲곕줉??JSON?쇰줈 蹂댁뿬以?
// ===============================
app.get("/report", async (req, res) => {
  try {
    const data = await fetchDailyRecordRows(REPORT_ROW_LIMIT);
    res.json({ ok: true, rows: data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/rebuild-report", async (req, res) => {
  try {
    const result = await rebuildReportJson("manual-endpoint");
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/archive-index", async (req, res) => {
  try {
    const months = await fetchArchiveIndexFromGitHub();
    res.json({ ok: true, months });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/archive-month", async (req, res) => {
  const { year, month, overwrite } = req.body || {};

  try {
    const monthKey = normalizeMonthKey(year, month);
    console.log("ARCHIVE_MONTH_START", monthKey);

    const allRows = await fetchAllDailyRecordRows();
    const targetRows = allRows.filter(row => extractRowMonthKey(row) === monthKey);

    console.log("ARCHIVE_MONTH_ROW_COUNT", monthKey, targetRows.length);

    const archivePayload = {
      ok: true,
      month: monthKey,
      rowCount: targetRows.length,
      rows: targetRows
    };

    const archivePath = `data/archive/${monthKey}.json`;
    const alreadyExists = await doesGitHubFileExist(archivePath);
    if (alreadyExists && !overwrite) {
      return res.status(409).json({
        ok: false,
        exists: true,
        month: monthKey,
        path: archivePath,
        error: "archive already exists"
      });
    }

    await upsertToGitHub(
      archivePath,
      JSON.stringify(archivePayload, null, 2),
      `archive month ${monthKey}`
    );

    const currentArchivedMonths = await fetchArchiveIndexFromGitHub();
    const updatedMonthsList = Array.from(new Set([...(currentArchivedMonths || []), monthKey])).sort();
    await upsertToGitHub(
      "data/archive-index.json",
      JSON.stringify({ months: updatedMonthsList }, null, 2),
      "update grid archive index"
    );

    console.log("ARCHIVE_MONTH_UPLOAD_OK", monthKey, archivePath);
    res.json({ ok: true, month: monthKey, rowCount: targetRows.length, path: archivePath, overwritten: alreadyExists });
  } catch (error) {
    console.error("ARCHIVE_MONTH_UPLOAD_FAIL", year, month, error);
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// ===============================
// ?붾젅洹몃옩 Webhook
// ===============================
app.post("/telegram", async (req, res) => {
  try {
    const text = req.body?.message?.text;
    const chatId = req.body?.message?.chat?.id;

    console.log("[TG] update body:", JSON.stringify(req.body).slice(0, 500));
    console.log("[TG] text:", text);

    // ?띿뒪?멸? ?놁쑝硫?洹몃깷 200
    if (!text) return res.sendStatus(200);

    const today = new Date().toISOString().slice(0, 10);

    const { error } = await supabase.from("daily_records").insert({
      date: today,
      raw_message: text
    });

    if (error) {
      console.error("[SUPABASE] insert error:", error);
    } else {
      console.log("[SUPABASE] insert OK");
    }

    // 理쒖떊 ?곗씠??議고쉶?섏뿬 GitHub???낅뜲?댄듃
    await rebuildReportJson(`telegram:${today}`);

    // ?붾젅洹몃옩?먮뒗 鍮⑤━ 200??二쇰뒗 寃?以묒슂
    res.sendStatus(200);

  } catch (e) {
    console.error("[ERROR] /telegram:", e);
    res.sendStatus(200);
  }
});

// Render ?ы듃 ?ㅽ뻾
const port = PORT || 3000;
app.listen(port, () => {
  console.log("Server started on port", port);
});



