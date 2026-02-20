import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

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

// ===============================
// 기본 테스트
// ===============================
app.get("/", (req, res) => {
  res.send("서버 살아있음");
});

// ===============================
// 리포트 조회 API
// ===============================
app.get("/report", async (req, res) => {
  const { data, error } = await supabase
    .from("daily_records")
    .select("date, raw_message, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[SUPABASE] select error:", error);
    return res.status(500).json({ ok: false, error });
  }

  res.json({ ok: true, rows: data });
});

// ===============================
// 텔레그램 Webhook
// ===============================
app.post("/telegram", async (req, res) => {
  try {
    const text = req.body?.message?.text;

    console.log("[TG] text:", text);

    if (!text) return res.sendStatus(200);

    const today = new Date().toISOString().slice(0, 10);

    const { error } = await supabase.from("daily_records").insert({
      date: today,
      raw_message: text
    });

    if (error) {
      console.error("[SUPABASE] insert error:", error);
      return res.sendStatus(200);
    }

    console.log("[SUPABASE] insert OK");

    // 최신 데이터 조회
    const { data: rows, error: selErr } = await supabase
      .from("daily_records")
      .select("date, raw_message, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (!selErr) {
      const report = { ok: true, rows };

      await upsertToGitHub(
        "data/report.json",
        JSON.stringify(report, null, 2),
        `update report ${today}`
      );
    }

    res.sendStatus(200);

  } catch (e) {
    console.error("[ERROR] /telegram:", e);
    res.sendStatus(200);
  }
});

// ===============================
app.listen(PORT || 3000, () => {
  console.log("Server started");
});
