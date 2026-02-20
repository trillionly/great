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

// Supabase 연결
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 테스트용
app.get("/", (req, res) => {
  res.send("서버 살아있음");
});
// 최근 50개 기록을 JSON으로 보여줌 (사이트/대시보드용)
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

  return res.json({ ok: true, rows: data });
});
// 텔레그램 Webhook
app.post("/telegram", async (req, res) => {
  try {
    const text = req.body?.message?.text;
    const chatId = req.body?.message?.chat?.id;

    console.log("[TG] update body:", JSON.stringify(req.body).slice(0, 500));
    console.log("[TG] text:", text);

    // 텍스트가 없으면 그냥 200
    if (!text) return res.sendStatus(200);

    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase.from("daily_records").insert({
      date: today,
      raw_message: text,
    });

    if (error) {
      console.error("[SUPABASE] insert error:", error);
    } else {
      console.log("[SUPABASE] insert OK");
    }

    // 텔레그램에는 빨리 200을 주는 게 중요
    return res.sendStatus(200);
  } catch (e) {
    console.error("[ERROR] /telegram:", e);
    return res.sendStatus(200);
  }
});

// Render 포트
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
