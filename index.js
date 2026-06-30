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

// 모든 요청 로그를 출력해 디버깅에 활용
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// ===============================
// 환경 변수
// ===============================
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  GH_TOKEN,
  GH_OWNER,
  GH_REPO,
  PORT,
  FINNHUB_API_KEY,
  SNAPSHOT_TOKEN
} = process.env;
const REPORT_ROW_LIMIT = 500;

// ===============================
// Supabase 클라이언트
// ===============================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===============================
// GitHub 파일 업로드 함수
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
    // 기존 파일의 SHA를 먼저 확인
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

    // 업로드 실패 응답은 바로 예외 처리
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
    const d = new Date(Number(baseYear), Number(rawDateMatch[1]) - 1, Number(rawDateMatch[2]), Number(rawDateMatch[3].split(":")[0]));
    d.setHours(d.getHours() - 12);
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
// 기본 헬스 체크
// ===============================
app.get("/", (req, res) => {
  res.send("정상 동작 중입니다.");
});

// ===============================
// 리포트 조회 API (최근 50개 기록을 JSON으로 반환)
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
    res.json({ ok: true, month: monthKey, rowCount: targetRows.length, path: archivePath, overwritten: alreadyExists, rows: targetRows });
  } catch (error) {
    console.error("ARCHIVE_MONTH_UPLOAD_FAIL", year, month, error);
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// ===============================
// 장투리밸런싱 일일 스냅샷
// ===============================
function getKoreanDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(part => {
    if (part.type !== "literal") map[part.type] = part.value;
  });
  return `${map.year}. ${parseInt(map.month, 10)}. ${parseInt(map.day, 10)}`;
}

async function fetchFinnhubQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub quote failed for ${symbol}: ${res.status}`);
  const data = await res.json();
  if (typeof data?.c !== "number" || data.c <= 0) {
    throw new Error(`Invalid quote for ${symbol}: ${JSON.stringify(data)}`);
  }
  return data.c;
}

app.post("/snapshot/long-term", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!SNAPSHOT_TOKEN || token !== SNAPSHOT_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const recordDate = getKoreanDateKey();

    const { data: existing, error: existErr } = await supabase
      .from("daily_snapshot")
      .select("id")
      .eq("record_date", recordDate)
      .limit(1);
    if (existErr) throw existErr;
    if (existing && existing.length > 0) {
      console.log("[SNAPSHOT] skip — already exists for", recordDate);
      return res.json({ ok: true, skipped: true, reason: "already_exists", recordDate });
    }

    const { data: trades, error: tradeErr } = await supabase
      .from("long_term_trade")
      .select("*");
    if (tradeErr) throw tradeErr;

    const assets = { SCHD: { qty: 0, cost: 0 }, QLD: { qty: 0, cost: 0 } };
    (trades || []).forEach(t => {
      const target = assets[t.ticker];
      if (!target) return;
      if (t.trade_type === "매수") {
        target.qty += t.quantity;
        target.cost += t.total_amount;
      } else {
        const avg = target.qty > 0 ? target.cost / target.qty : 0;
        target.qty -= t.quantity;
        target.cost -= avg * t.quantity;
      }
    });

    const totalInvested = assets.SCHD.cost + assets.QLD.cost;

    const [schdPrice, qldPrice] = await Promise.all([
      fetchFinnhubQuote("SCHD"),
      fetchFinnhubQuote("QLD")
    ]);

    const totalAsset = assets.SCHD.qty * schdPrice + assets.QLD.qty * qldPrice;

    const { error: insertErr } = await supabase.from("daily_snapshot").insert({
      record_date: recordDate,
      total_asset: totalAsset,
      principal: totalInvested
    });
    if (insertErr) throw insertErr;

    console.log("[SNAPSHOT] inserted", recordDate, "totalAsset:", totalAsset);
    return res.json({
      ok: true,
      recordDate,
      totalAsset,
      principal: totalInvested,
      schd: { qty: assets.SCHD.qty, price: schdPrice },
      qld: { qty: assets.QLD.qty, price: qldPrice }
    });
  } catch (error) {
    console.error("[SNAPSHOT] error:", error);
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// ===============================
// 텔레그램 Webhook
// ===============================
app.post("/telegram", async (req, res) => {
  try {
    const text = req.body?.message?.text;
    const chatId = req.body?.message?.chat?.id;

    console.log("[TG] update body:", JSON.stringify(req.body).slice(0, 500));
    console.log("[TG] text:", text);

    // 텍스트 메시지가 아니면 텔레그램에 200 응답만 반환
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

    // 최신 데이터를 다시 조회해 GitHub 리포트도 갱신
    await rebuildReportJson(`telegram:${today}`);

    // 텔레그램에는 항상 빠르게 200 응답을 반환
    res.sendStatus(200);
  } catch (e) {
    console.error("[ERROR] /telegram:", e);
    res.sendStatus(200);
  }
});

// 서버 실행
const port = PORT || 3000;
app.listen(port, () => {
  console.log("Server started on port", port);
});
