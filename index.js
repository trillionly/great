import fetch from "node-fetch";
import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// 모든 요청 로그 찍기 (중요)
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// ===============================
// 환경변수
// ===============================
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  GH_TOKEN,
  GH_OWNER,
  GH_REPO,
  GH_BRANCH,
  REPORT_JSON_ROW_LIMIT,
  PORT
} = process.env;

const REPORT_PATH = "data/report.json";
const TARGET_OWNER = GH_OWNER || "trillionly";
const TARGET_REPO = GH_REPO || "great";
const TARGET_BRANCH = GH_BRANCH || "main";
const REPORT_LIMIT = Number(REPORT_JSON_ROW_LIMIT) > 0 ? Number(REPORT_JSON_ROW_LIMIT) : 1000;

// ===============================
// Supabase 연결
// ===============================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function summarizeRows(rows = []) {
  const count = Array.isArray(rows) ? rows.length : 0;
  const firstRowDate = count ? rows[0]?.date || null : null;
  const lastRowDate = count ? rows[count - 1]?.date || null : null;
  const newestRowDate = count
    ? rows.reduce((latest, row) => {
        const current = row?.date || "";
        return current > latest ? current : latest;
      }, "")
    : null;

  return { count, newestRowDate, firstRowDate, lastRowDate };
}

function previewMessage(text, length = 180) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
}

function findNewestRow(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return null;

  return rows.reduce((latest, row) => {
    if (!latest) return row;

    const latestCreatedAt = latest?.created_at || "";
    const currentCreatedAt = row?.created_at || "";
    if (currentCreatedAt > latestCreatedAt) return row;
    if (currentCreatedAt === latestCreatedAt && (row?.date || "") > (latest?.date || "")) return row;
    return latest;
  }, null);
}

async function fetchReportRows() {
  console.log("[SUPABASE] report generation query", {
    table: "daily_records",
    select: "date, raw_message, created_at",
    orderBy: "created_at desc",
    limit: REPORT_LIMIT
  });

  const query = supabase
    .from("daily_records")
    .select("date, raw_message, created_at")
    .order("created_at", { ascending: false })
    .limit(REPORT_LIMIT);

  const { data: rows, error } = await query;

  if (error) {
    console.error("[SUPABASE] report rows select failed:", error);
    throw error;
  }

  const summary = summarizeRows(rows || []);
  const newestRow = findNewestRow(rows || []);
  console.log("[SUPABASE] report rows fetched", {
    limit: REPORT_LIMIT,
    count: summary.count,
    newestRowDate: summary.newestRowDate,
    firstRowDate: summary.firstRowDate,
    lastRowDate: summary.lastRowDate,
    newestRowCreatedAt: newestRow?.created_at || null,
    newestRowPreview: previewMessage(newestRow?.raw_message)
  });

  return rows || [];
}

// ===============================
// GitHub 업서트 함수
// ===============================
async function upsertToGitHub(path, contentText, message) {
  if (!GH_TOKEN) {
    const error = new Error("Missing GitHub env vars");
    console.error("[GH] Missing env vars, skip GitHub update", {
      hasToken: Boolean(GH_TOKEN),
      owner: TARGET_OWNER,
      repo: TARGET_REPO,
      branch: TARGET_BRANCH,
      path
    });
    throw error;
  }

  console.log("[GH] about to update GitHub", {
    owner: TARGET_OWNER,
    repo: TARGET_REPO,
    branch: TARGET_BRANCH,
    path
  });

  const api = `https://api.github.com/repos/${TARGET_OWNER}/${TARGET_REPO}/contents/${path}`;
  const getApi = `${api}?ref=${encodeURIComponent(TARGET_BRANCH)}`;

  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "telegram-invest-server"
  };

  try {
    // 기존 파일 SHA 확인
    let sha = null;
    const getRes = await fetch(getApi, { headers });
    const getText = await getRes.text();

    console.log("[GH] GET existing file response", {
      status: getRes.status,
      body: getText.slice(0, 2000)
    });

    if (getRes.status === 200) {
      const j = JSON.parse(getText);
      sha = j.sha;
      console.log("[GH] existing SHA fetched", { sha });
    } else if (getRes.status !== 404) {
      throw new Error(`[GH] GET failed: ${getRes.status} ${getText}`);
    } else {
      console.log("[GH] existing file not found, creating new file");
    }

    const body = {
      message,
      content: Buffer.from(contentText, "utf8").toString("base64"),
      branch: TARGET_BRANCH,
      ...(sha ? { sha } : {})
    };

    const putRes = await fetch(api, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const putText = await putRes.text();

    if (![200, 201].includes(putRes.status)) {
      console.error("[GH] PUT failed", {
        status: putRes.status,
        body: putText.slice(0, 4000)
      });
      throw new Error(`[GH] PUT failed: ${putRes.status} ${putText}`);
    } else {
      console.log("GITHUB_UPLOAD_OK", {
        owner: TARGET_OWNER,
        repo: TARGET_REPO,
        branch: TARGET_BRANCH,
        path,
        status: putRes.status,
        body: putText.slice(0, 2000)
      });
    }

  } catch (err) {
    console.error("[GH] error:", err);
    throw err;
  }
}

// ===============================
// 기본 테스트
// ===============================
app.get("/", (req, res) => {
  res.send("서버 살아있음");
});

// ===============================
// 리포트 조회 API (최근 50개 기록을 JSON으로 보여줌)
// ===============================
app.get("/report", async (req, res) => {
  try {
    const rows = await fetchReportRows();
    res.json({ ok: true, rows });
  } catch (error) {
    console.error("[SUPABASE] select error:", error);
    return res.status(500).json({ ok: false, error });
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

    // 텍스트가 없으면 그냥 200
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

    // 최신 데이터 조회하여 GitHub에 업데이트
    const rows = await fetchReportRows();
    const summary = summarizeRows(rows);
    const newestFetchedRow = findNewestRow(rows);
    const report = { ok: true, rows };
    const finalRows = report.rows || [];
    const finalSummary = summarizeRows(finalRows);
    const newestFinalRow = findNewestRow(finalRows);
    const hasTargetRow = finalRows.some(row => row?.date === "2026-03-24");

    console.log("REPORT_JSON_BUILD_OK", {
      fetchedCount: summary.count,
      fetchedNewestDate: summary.newestRowDate,
      fetchedNewestCreatedAt: newestFetchedRow?.created_at || null,
      fetchedNewestPreview: previewMessage(newestFetchedRow?.raw_message),
      finalCount: finalSummary.count,
      finalNewestDate: finalSummary.newestRowDate,
      finalNewestCreatedAt: newestFinalRow?.created_at || null,
      finalNewestPreview: previewMessage(newestFinalRow?.raw_message),
      has2026_03_24Row: hasTargetRow
    });

    await upsertToGitHub(
      REPORT_PATH,
      JSON.stringify(report, null, 2),
      `update report ${summary.newestRowDate || today}`
    );

    // 텔레그램에는 빨리 200을 주는 게 중요
    res.sendStatus(200);

  } catch (e) {
    console.error("[ERROR] /telegram:", e);
    res.sendStatus(200);
  }
});

// Render 포트 실행
const port = PORT || 3000;
app.listen(port, () => {
  console.log("Server started on port", port);
});
