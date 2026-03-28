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
  PORT
} = process.env;
const REPORT_ROW_LIMIT = 500;

// ===============================
// Supabase 연결
// ===============================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===============================
// GitHub 업서트 함수
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
    // 기존 파일 SHA 확인
    let sha = null;
    const getRes = await fetch(api, { headers });

    if (getRes.status === 200) {
      const j = await getRes.json();
      sha = j.sha;
    } else if (getRes.status !== 404) {
      const t = await getRes.text();
      console.error("[GH] GET failed:", getRes.status, t);
      return;
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

    // 테스트용
    if (![200, 201].includes(putRes.status)) {
      const t = await putRes.text();
      console.error("[GH] PUT failed:", putRes.status, t);
    } else {
      console.log("[GH] report.json updated");
    }

  } catch (err) {
    console.error("[GH] error:", err);
  }
}

async function rebuildReportJson(reason = "manual") {
  const { data: rows, error } = await supabase
    .from("daily_records")
    .select("date, raw_message, created_at")
    .order("created_at", { ascending: false })
    .limit(REPORT_ROW_LIMIT);

  if (error) {
    console.error("[SUPABASE] report rebuild select error:", error);
    throw error;
  }

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
// 기본 테스트
// ===============================
app.get("/", (req, res) => {
  res.send("서버 살아있음");
});

// ===============================
// 리포트 조회 API (최근 50개 기록을 JSON으로 보여줌)
// ===============================
app.get("/report", async (req, res) => {
  const { data, error } = await supabase
    .from("daily_records")
    .select("date, raw_message, created_at")
    .order("created_at", { ascending: false })
    .limit(REPORT_ROW_LIMIT);

  if (error) {
    console.error("[SUPABASE] select error:", error);
    return res.status(500).json({ ok: false, error });
  }

  res.json({ ok: true, rows: data });
});

app.post("/rebuild-report", async (req, res) => {
  try {
    const result = await rebuildReportJson("manual-endpoint");
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
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
    await rebuildReportJson(`telegram:${today}`);

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
