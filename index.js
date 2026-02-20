import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// Supabase 연결
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 테스트용 (브라우저에서 열면 확인 가능)
app.get("/", (req, res) => {
  res.send("서버 살아있음");
});

// 텔레그램 메시지 받는 곳
app.post("/telegram", async (req, res) => {
  const text = req.body?.message?.text;
  if (!text) return res.sendStatus(200);

  await supabase.from("daily_records").insert({
    date: new Date().toISOString().slice(0, 10),
    raw_message: text,
  });

  res.sendStatus(200);
});

// Render가 포트 지정
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
