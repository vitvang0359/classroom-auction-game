const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error("THIEU ADMIN_KEY. Hay dat bien moi truong ADMIN_KEY truoc khi chay.");
  process.exit(1);
}

const DATA_FILE = path.join(__dirname, "data.json");

const defaultData = {
  settings: {
    title: "ĐẤU GIÁ KIẾN THỨC",
    topic: "Chủ đề",
    auctionSeconds: 20,
    answerMultipleSeconds: 15,
    answerOpenSeconds: 30,
    startingPoints: 1000,
    teams: ["Tổ 1", "Tổ 2", "Tổ 3", "Tổ 4"]
  },
  questions: [],
  homeImageUrl: null,
  scores: [1000, 1000, 1000, 1000],
  claims: [null, null, null, null],
  currentIndex: 0,
  phase: "home",
  round: 0,
  auctionEndsAt: null,
  answerEndsAt: null,
  bids: {},
  winner: null,
  secondBidder: null,
  activeResponder: null,
  lastAttempt: null,
  revealed: false,
  result: null,
  ended: false
};

function loadLocalData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return { ...structuredClone(defaultData), ...saved };
    }
  } catch (e) {
    console.error("Khong doc duoc data.json:", e);
  }
  return structuredClone(defaultData);
}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
let state = loadLocalData();
let auctionTimer = null;
let answerTimer = null;
let saveQueue = Promise.resolve();

async function loadPersistentData() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.warn("Chua cau hinh Supabase; tam thoi dung data.json.");
    return;
  }

  const response = await fetch(
    SUPABASE_URL + "/rest/v1/game_state?select=state&id=eq.1",
    {
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: "Bearer " + SUPABASE_SECRET_KEY
      }
    }
  );

  if (!response.ok) {
    throw new Error("Supabase doc du lieu that bai: " + response.status + " " + await response.text());
  }

  const rows = await response.json();
  if (rows.length && rows[0].state) {
    state = { ...structuredClone(defaultData), ...rows[0].state };
    console.log("Da tai du lieu game tu Supabase.");
  } else {
    await save();
    await saveQueue;
    console.log("Da tao du lieu game ban dau tren Supabase.");
  }
}

function save() {
  const snapshot = structuredClone(state);
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    console.warn("Khong the ghi data.json tam thoi:", e.message);
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;

  saveQueue = saveQueue.then(async () => {
    const response = await fetch(SUPABASE_URL + "/rest/v1/game_state?on_conflict=id", {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: "Bearer " + SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({ id: 1, state: snapshot, updated_at: new Date().toISOString() })
    });
    if (!response.ok) {
      throw new Error("Supabase luu du lieu that bai: " + response.status + " " + await response.text());
    }
  }).catch(error => {
    console.error(error.message);
  });
}

function publicQuestion() {
  const q = state.questions[state.currentIndex];
  if (!q) return null;

  const type = q.type === "open" ? "open" : "multiple";
  if (!state.revealed) {
    return {
      number: state.currentIndex + 1, total: state.questions.length, type,
      topic: q.topic || state.settings.topic || "Chưa có chủ đề",
      question: null, answers: null
    };
  }
  return {
    number: state.currentIndex + 1, total: state.questions.length, type,
    topic: q.topic || state.settings.topic || "Chưa có chủ đề",
    question: q.question,
    answers: type === "open" ? null : q.answers,
    openAnswer: type === "open" && state.phase === "answered" && state.result?.type === "open"
      ? (q.openAnswer || "Chưa nhập đáp án mẫu cho câu hỏi này.")
      : null
  };
}

function adminSnapshot() {
  return {
    settings: state.settings,
    questions: state.questions,
    homeImageUrl: state.homeImageUrl || null,
    scores: state.scores,
    currentIndex: state.currentIndex,
    phase: state.phase,
    round: state.round,
    auctionEndsAt: state.auctionEndsAt,
    answerEndsAt: state.answerEndsAt,
    winner: state.winner,
    secondBidder: state.secondBidder,
    activeResponder: state.activeResponder,
    lastAttempt: state.lastAttempt,
    revealed: state.revealed,
    result: state.result,
    ended: state.ended,
    question: publicQuestion()
  };
}

function teamSnapshot(teamIndex) {
  return {
    settings: {
      title: state.settings.title,
      teams: state.settings.teams
    },
    teamIndex,
    teamName: state.settings.teams[teamIndex],
    points: state.scores[teamIndex],
    phase: state.phase,
    round: state.round,
    auctionEndsAt: state.auctionEndsAt,
    answerEndsAt: state.answerEndsAt,
    question: publicQuestion(),
    winner: state.winner,
    secondBidder: state.secondBidder,
    activeResponder: state.activeResponder,
    lastAttempt: state.lastAttempt,
    result: state.result,
    ended: state.ended,
    myBid: state.bids[teamIndex] || null
  };
}

function broadcast() {
  io.to("admins").emit("admin-state", adminSnapshot());

  for (let i = 0; i < 4; i++) {
    io.to(`team-${i}`).emit("team-state", teamSnapshot(i));
  }
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Không có quyền quản trị." });
  }
  next();
}

function getTeam(req, res, next) {
  const token = req.headers["x-team-token"];
  if (!token) return res.status(401).json({ error: "Chưa đăng nhập tổ." });

  const index = state.claims.findIndex(
    claim => claim && claim.token === token
  );

  if (index < 0) {
    return res.status(401).json({ error: "Phiên tổ không hợp lệ." });
  }

  req.teamIndex = index;
  next();
}

function stopAuctionTimer() {
  if (auctionTimer) clearTimeout(auctionTimer);
  auctionTimer = null;
}

function stopAnswerTimer() {
  if (answerTimer) clearTimeout(answerTimer);
  answerTimer = null;
}

function answerDurationMs() {
  const q = state.questions[state.currentIndex];
  const seconds = q?.type === "open"
    ? state.settings.answerOpenSeconds
    : state.settings.answerMultipleSeconds;
  return Math.max(1, Number(seconds) || (q?.type === "open" ? 30 : 15)) * 1000;
}

function startAnswerTimer() {
  stopAnswerTimer();
  if (state.phase !== "question" || !state.answerEndsAt) return;
  const remaining = Math.max(0, state.answerEndsAt - Date.now());
  answerTimer = setTimeout(handleAnswerTimeout, remaining);
}

function chargeBid(teamIndex) {
  const bid = state.bids[teamIndex];
  if (!bid || bid.charged) return;
  state.scores[teamIndex] = Math.max(0, state.scores[teamIndex] - bid.amount);
  bid.charged = true;
}

function finishAnswerAttempt(teamIndex, timedOut, correct = false, selected = null) {
  const bid = state.bids[teamIndex];
  const amount = bid ? bid.amount : 0;
  // Tiền cược đã bị trừ khi đội được gọi trả lời; đúng thì nhận thưởng 2 lần tiền cược.
  if (correct) state.scores[teamIndex] += amount * 2;
  state.lastAttempt = { teamIndex, timedOut, isCorrect: correct };
  stopAnswerTimer();

  if (!correct && state.activeResponder?.teamIndex === state.winner?.teamIndex &&
      state.secondBidder && state.secondBidder.teamIndex !== teamIndex) {
    state.activeResponder = { ...state.secondBidder };
    // Chỉ trừ tiền cược của đội thứ hai khi đội này thực sự được gọi trả lời.
    chargeBid(state.activeResponder.teamIndex);
    // Chuyển lượt nhưng chờ quản trò chủ động bấm bắt đầu tính giờ.
    state.answerEndsAt = null;
    state.result = null;
    save();
    broadcast();
    return { nextResponder: state.activeResponder };
  }

  state.result = {
    type: state.questions[state.currentIndex]?.type === "open" ? "open" : "multiple",
    selected,
    correctAnswer: state.questions[state.currentIndex]?.correct || null,
    isCorrect: correct,
    timedOut,
    teamIndex
  };
  state.phase = "answered";
  state.answerEndsAt = null;
  state.activeResponder = null;
  save();
  broadcast();
  return { finished: true };
}

function handleAnswerTimeout() {
  if (state.phase !== "question" || !state.activeResponder) return;
  if (state.answerEndsAt && Date.now() < state.answerEndsAt) {
    startAnswerTimer();
    return;
  }
  finishAnswerAttempt(state.activeResponder.teamIndex, true, false);
}

function startAuctionTimer() {
  stopAuctionTimer();

  if (state.phase !== "auction" || !state.auctionEndsAt) return;

  const remaining = Math.max(0, state.auctionEndsAt - Date.now());

  auctionTimer = setTimeout(() => {
    finishAuction();
  }, remaining);
}

function finishAuction() {
  if (state.phase !== "auction") return;

  stopAuctionTimer();
  state.auctionEndsAt = null;

  const eligible = Object.entries(state.bids)
    .map(([index, bid]) => ({
      index: Number(index),
      amount: bid.amount,
      time: bid.confirmedAt || bid.draftAt
    }))
    .filter(bid =>
      Number.isInteger(bid.amount) &&
      bid.amount > 0 &&
      bid.amount <= state.scores[bid.index]
    );

  eligible.sort((a, b) =>
    b.amount - a.amount || a.time - b.time
  );

  if (eligible.length === 0) {
    const canBid = state.scores.some(points => points >= 10);

    if (!canBid) {
      state.phase = "no-bidders";
      state.winner = null;
      save();
      broadcast();
      return;
    }

    state.round += 1;
    state.bids = {};
    state.winner = null;
    state.phase = "auction";
    state.auctionEndsAt = Date.now() + state.settings.auctionSeconds * 1000;
    save();
    broadcast();
    startAuctionTimer();
    return;
  }

  state.winner = {
    teamIndex: eligible[0].index,
    teamName: state.settings.teams[eligible[0].index]
  };
  state.secondBidder = eligible[1] ? {
    teamIndex: eligible[1].index,
    teamName: state.settings.teams[eligible[1].index]
  } : null;
  // Trừ tiền cược của đội thắng ngay khi xác định đội được quyền trả lời.
  chargeBid(state.winner.teamIndex);
  state.activeResponder = null;
  state.answerEndsAt = null;
  state.lastAttempt = null;

  state.phase = "winner";
  save();
  broadcast();
}

function validBid(amount, teamIndex) {
  return Number.isInteger(amount) &&
    amount > 0 &&
    amount % 10 === 0 &&
    amount <= state.scores[teamIndex];
}

// Trang web phụ
app.get("/team", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "team.html"));
});

// Đăng nhập tổ
app.post("/api/team/claim", (req, res) => {
  const index = Number(req.body.teamIndex);

  if (!Number.isInteger(index) || index < 0 || index > 3) {
    return res.status(400).json({ error: "Tổ không hợp lệ." });
  }

  if (state.claims[index]) {
    return res.status(409).json({
      error: "Tổ này đã có thiết bị tham gia."
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  state.claims[index] = { token, joinedAt: Date.now() };

  save();
  broadcast();

  res.json({
    token,
    teamIndex: index,
    teamName: state.settings.teams[index]
  });
});

// Lấy trạng thái tổ
app.get("/api/team/state", getTeam, (req, res) => {
  res.json(teamSnapshot(req.teamIndex));
});

// Cập nhật giá đang nhập.
// Giá nháp cũng được lưu trên máy chủ để không mất khi hết giờ.
app.post("/api/team/draft", getTeam, (req, res) => {
  if (state.phase !== "auction") {
    return res.status(400).json({ error: "Hiện không trong lượt đấu giá." });
  }

  const amount = Number(req.body.amount);
  const i = req.teamIndex;

  if (state.bids[i]?.locked) {
    return res.status(409).json({ error: "Tổ đã chốt giá." });
  }

  if (Date.now() >= state.auctionEndsAt) {
    finishAuction();
    return res.status(400).json({ error: "Đã hết thời gian đấu giá." });
  }

  if (!validBid(amount, i)) {
    return res.status(400).json({
      error: "Giá phải là bội số của 10 và không vượt quá điểm hiện có."
    });
  }

  state.bids[i] = {
    amount,
    locked: false,
    draftAt: Date.now()
  };

  save();
  res.json({ success: true });
});

// Chốt giá
app.post("/api/team/confirm", getTeam, (req, res) => {
  const i = req.teamIndex;
  const bid = state.bids[i];

  if (state.phase !== "auction" || Date.now() >= state.auctionEndsAt) {
    finishAuction();
    return res.status(400).json({ error: "Đã hết thời gian đấu giá." });
  }

  if (!bid || bid.locked) {
    return res.status(400).json({ error: "Không có giá hợp lệ để chốt." });
  }

  if (!validBid(bid.amount, i)) {
    return res.status(400).json({ error: "Giá đấu không hợp lệ." });
  }

  bid.locked = true;
  bid.confirmedAt = Date.now();

  save();
  broadcast();

  res.json({ success: true });
});

// Cấu hình công khai cho màn hình chọn tổ
app.get("/api/public/settings", (req, res) => {
  res.json({
    title: state.settings.title,
    teams: state.settings.teams
  });
});

// Socket: đồng bộ trạng thái
io.on("connection", socket => {
  socket.on("admin-connect", key => {
    if (key === ADMIN_KEY) {
      socket.join("admins");
      socket.emit("admin-state", adminSnapshot());
    }
  });

  socket.on("team-connect", token => {
    const index = state.claims.findIndex(
      claim => claim && claim.token === token
    );

    if (index >= 0) {
      socket.join(`team-${index}`);
      socket.emit("team-state", teamSnapshot(index));
    }
  });
});

// API quản trị
app.get("/api/admin/state", requireAdmin, (req, res) => {
  res.json(adminSnapshot());
});

// Cập nhật cấu hình
app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const body = req.body;

  if (body.title !== undefined) {
    state.settings.title = String(body.title).slice(0, 100);
  }

  if (body.topic !== undefined) {
    state.settings.topic = String(body.topic).slice(0, 100);
  }

  if (body.auctionSeconds !== undefined) {
    const n = Number(body.auctionSeconds);
    if (!Number.isInteger(n) || n < 5 || n > 300) {
      return res.status(400).json({ error: "Thời gian đấu giá phải từ 5 đến 300 giây." });
    }
    state.settings.auctionSeconds = n;
  }

  for (const [field, label] of [
    ["answerMultipleSeconds", "trắc nghiệm"],
    ["answerOpenSeconds", "tự luận"]
  ]) {
    if (body[field] !== undefined) {
      const n = Number(body[field]);
      if (!Number.isInteger(n) || n < 5 || n > 300) {
        return res.status(400).json({ error: "Thời gian trả lời " + label + " phải từ 5 đến 300 giây." });
      }
      state.settings[field] = n;
    }
  }

  if (body.startingPoints !== undefined) {
    const n = Number(body.startingPoints);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: "Điểm khởi đầu không hợp lệ." });
    }

    state.settings.startingPoints = n;
  }

  if (Array.isArray(body.teams) && body.teams.length === 4) {
    state.settings.teams = body.teams.map(x => String(x).slice(0, 40));
  }

  save();
  broadcast();
  res.json({ success: true });
});

// Thêm, sửa hoặc xóa toàn bộ danh sách câu hỏi
app.post("/api/admin/questions", requireAdmin, (req, res) => {
  if (!Array.isArray(req.body.questions)) {
    return res.status(400).json({ error: "Danh sách câu hỏi không hợp lệ." });
  }

  const questions = req.body.questions.map(q => {
    const type = q.type === "open" ? "open" : "multiple";
    return {
      type,
      topic: String(q.topic || state.settings.topic || "Chưa có chủ đề"),
      question: String(q.question || ""),
      openAnswer: type === "open" ? String(q.openAnswer || "") : "",
      answers: type === "open" ? [] : (Array.isArray(q.answers) ? q.answers.slice(0, 4).map(a => String(a)) : []),
      correct: type === "open" ? "" : String(q.correct || "").toUpperCase()
    };
  });
  const valid = questions.every(q =>
    q.topic.trim() && q.question.trim() &&
    (q.type === "open" || (q.answers.length === 4 && q.answers.every(a => a.trim()) && ["A", "B", "C", "D"].includes(q.correct)))
  );
  if (!valid) {
    return res.status(400).json({
      error: "Mỗi câu cần chủ đề và nội dung. Câu trắc nghiệm phải có đủ 4 đáp án và đáp án đúng."
    });
  }

  state.questions = questions;
  state.currentIndex = 0;
  state.phase = "home";
  state.bids = {};
  state.winner = null;
  state.revealed = false;
  state.result = null;
  state.ended = false;

  save();
  broadcast();
  res.json({ success: true });
});

// Bắt đầu trò chơi
app.post("/api/admin/start", requireAdmin, (req, res) => {
  if (!state.questions.length) {
    return res.status(400).json({ error: "Chưa có câu hỏi." });
  }

  state.scores = Array(4).fill(state.settings.startingPoints);
  state.currentIndex = 0;
  state.round = 0;
  state.phase = "ready";
  state.bids = {};
  state.winner = null;
  state.secondBidder = null;
  state.activeResponder = null;
  state.answerEndsAt = null;
  state.lastAttempt = null;
  state.revealed = false;
  state.result = null;
  state.ended = false;
  stopAnswerTimer();

  save();
  broadcast();
  res.json({ success: true });
});

// Bắt đầu một lượt đấu giá
app.post("/api/admin/auction/start", requireAdmin, (req, res) => {
  if (state.ended || !state.questions.length) {
    return res.status(400).json({ error: "Trò chơi chưa sẵn sàng." });
  }

  if (!["ready", "winner", "answered", "no-bidders"].includes(state.phase)) {
    return res.status(400).json({ error: "Không thể bắt đầu đấu giá lúc này." });
  }

  if (state.scores.every(points => points < 10)) {
    state.phase = "no-bidders";
    save();
    broadcast();
    return res.status(400).json({ error: "Không còn tổ nào đủ điểm để đấu giá." });
  }

  state.round += 1;
  state.bids = {};
  state.winner = null;
  state.secondBidder = null;
  state.activeResponder = null;
  state.answerEndsAt = null;
  state.lastAttempt = null;
  stopAnswerTimer();
  state.revealed = false;
  state.result = null;
  state.phase = "auction";
  state.auctionEndsAt = Date.now() + state.settings.auctionSeconds * 1000;

  save();
  broadcast();
  startAuctionTimer();

  res.json({ success: true });
});

// Xác nhận kết thúc đấu giá thủ công nếu cần
app.post("/api/admin/auction/finish", requireAdmin, (req, res) => {
  if (state.phase !== "auction") {
    return res.status(400).json({ error: "Không có lượt đấu giá đang diễn ra." });
  }

  finishAuction();
  res.json({ success: true });
});

// Hiện câu hỏi và đáp án
app.post("/api/admin/reveal", requireAdmin, (req, res) => {
  if (state.phase !== "winner") {
    return res.status(400).json({ error: "Chưa xác định tổ thắng." });
  }

  state.revealed = true;
  state.phase = "question";
  state.activeResponder = { ...state.winner };
  state.answerEndsAt = Date.now() + answerDurationMs();
  state.lastAttempt = null;
  save();
  broadcast();
  startAnswerTimer();

  res.json({ success: true });
});

// Quản trò chủ động bắt đầu tính giờ cho tổ thứ hai
app.post("/api/admin/answer/start", requireAdmin, (req, res) => {
  if (state.phase !== "question" || !state.activeResponder || state.answerEndsAt) {
    return res.status(400).json({ error: "Hiện không có lượt trả lời nào đang chờ bắt đầu." });
  }

  state.answerEndsAt = Date.now() + answerDurationMs();
  save();
  broadcast();
  startAnswerTimer();
  res.json({ success: true });
});

// Chọn đáp án và tính điểm
app.post("/api/admin/answer", requireAdmin, (req, res) => {
  if (state.phase !== "question" || !state.activeResponder) {
    return res.status(400).json({ error: "Hiện không có đội nào đang trả lời." });
  }
  if (!state.answerEndsAt) {
    return res.status(400).json({ error: "Quản trò chưa bắt đầu tính giờ cho tổ này." });
  }
  if (Date.now() >= state.answerEndsAt) {
    handleAnswerTimeout();
    return res.status(400).json({ error: "Đã hết thời gian trả lời." });
  }

  const q = state.questions[state.currentIndex];
  const teamIndex = state.activeResponder.teamIndex;
  const isOpen = q.type === "open";
  let correct;
  let selected = null;

  if (isOpen) {
    if (typeof req.body.isCorrect !== "boolean") {
      return res.status(400).json({ error: "Hãy chọn ĐÚNG hoặc SAI để chấm câu tự luận." });
    }
    correct = req.body.isCorrect;
  } else {
    selected = String(req.body.answer || "").toUpperCase();
    if (!["A", "B", "C", "D"].includes(selected)) {
      return res.status(400).json({ error: "Đáp án không hợp lệ." });
    }
    correct = selected === q.correct;
  }

  const outcome = finishAnswerAttempt(teamIndex, false, correct, selected);
  res.json({ success: true, result: state.result, nextResponder: outcome.nextResponder || null });
});

// Sang câu tiếp theo
app.post("/api/admin/next", requireAdmin, (req, res) => {
  if (state.phase !== "answered") {
    return res.status(400).json({ error: "Câu hiện tại chưa kết thúc." });
  }

  if (state.currentIndex + 1 >= state.questions.length) {
    state.phase = "finished";
    state.ended = true;
    save();
    broadcast();
    return res.json({ success: true, finished: true });
  }

  stopAnswerTimer();
  state.currentIndex += 1;
  state.phase = "ready";
  state.bids = {};
  state.winner = null;
  state.secondBidder = null;
  state.activeResponder = null;
  state.answerEndsAt = null;
  state.lastAttempt = null;
  state.revealed = false;
  state.result = null;
  state.auctionEndsAt = null;

  save();
  broadcast();

  res.json({ success: true });
});

// Kết thúc trò chơi
app.post("/api/admin/end", requireAdmin, (req, res) => {
  stopAuctionTimer();
  stopAnswerTimer();
  state.answerEndsAt = null;
  state.phase = "finished";
  state.ended = true;
  state.auctionEndsAt = null;
  save();
  broadcast();
  res.json({ success: true });
});

// Cộng/trừ điểm thủ công
app.post("/api/admin/score", requireAdmin, (req, res) => {
  const i = Number(req.body.teamIndex);
  const delta = Number(req.body.delta);

  if (!Number.isInteger(i) || i < 0 || i > 3 ||
      !Number.isInteger(delta)) {
    return res.status(400).json({ error: "Dữ liệu điểm không hợp lệ." });
  }

  state.scores[i] = Math.max(0, state.scores[i] + delta);
  save();
  broadcast();
  res.json({ success: true });
});

// Đặt lại thiết bị đã tham gia một tổ
app.post("/api/admin/release-team", requireAdmin, (req, res) => {
  const i = Number(req.body.teamIndex);

  if (!Number.isInteger(i) || i < 0 || i > 3) {
    return res.status(400).json({ error: "Tổ không hợp lệ." });
  }

  state.claims[i] = null;
  save();
  broadcast();
  res.json({ success: true });
});

// Tải ảnh/video trực tiếp lên Supabase Storage để không mất khi Render khởi động lại
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /image\/|video\//.test(file.mimetype);
    cb(allowed ? null : new Error("Chỉ chấp nhận ảnh hoặc video."), allowed);
  }
});

app.post("/api/admin/upload", requireAdmin, upload.single("media"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Chưa chọn tệp." });
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return res.status(500).json({ error: "Máy chủ chưa cấu hình Supabase Storage." });
  }

  const ext = path.extname(req.file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const filename = crypto.randomUUID() + ext;
  const objectPath = "uploads/" + filename;
  const uploadUrl = SUPABASE_URL + "/storage/v1/object/game-media/" + objectPath
    .split("/").map(encodeURIComponent).join("/");

  try {
    const storageResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: "Bearer " + SUPABASE_SECRET_KEY,
        "Content-Type": req.file.mimetype,
        "x-upsert": "true"
      },
      body: req.file.buffer
    });

    if (!storageResponse.ok) {
      const detail = await storageResponse.text();
      console.error("Supabase Storage upload failed:", storageResponse.status, detail);
      return res.status(502).json({ error: "Không tải được tệp lên Supabase Storage. Hãy kiểm tra bucket game-media." });
    }

    const publicUrl = SUPABASE_URL + "/storage/v1/object/public/game-media/" + objectPath;

    // Ảnh đại diện trang chủ được lưu đường dẫn vào game_state trên Supabase.
    if (req.body && req.body.purpose === "home") {
      if (!req.file.mimetype.startsWith("image/")) {
        return res.status(400).json({ error: "Ảnh đại diện chỉ chấp nhận tệp hình ảnh." });
      }
      state.homeImageUrl = publicUrl;
      save();
      broadcast();
    }

    res.json({
      success: true,
      url: publicUrl,
      type: req.file.mimetype.startsWith("video/") ? "video" : "image"
    });
  } catch (error) {
    console.error("Supabase Storage upload error:", error);
    res.status(502).json({ error: "Lỗi kết nối Supabase Storage." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "main.html"));
});

async function startServer() {
  try {
    await loadPersistentData();
  } catch (error) {
    console.error("Khong the ket noi Supabase:", error.message);
    console.error("May chu dung lai de tranh ghi de du lieu online.");
    process.exit(1);
    return;
  }

  // Khôi phục bộ đếm thời gian nếu máy chủ khởi động lại giữa lượt
  if (state.phase === "question" && state.answerEndsAt) {
    if (state.answerEndsAt <= Date.now()) {
      handleAnswerTimeout();
    } else {
      startAnswerTimer();
    }
  }

  if (state.phase === "auction" && state.auctionEndsAt) {
    if (state.auctionEndsAt <= Date.now()) {
      finishAuction();
    } else {
      startAuctionTimer();
    }
  }

  server.listen(PORT, () => {
    console.log(`Game dang chay tai cong ${PORT}`);
  });
}

startServer();