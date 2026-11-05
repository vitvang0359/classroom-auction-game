let socket;
let adminKey = sessionStorage.getItem("adminKey") || "";
let currentState = null;
let countdownInterval = null;
let mediaUrl = "";
let mediaType = "";
let revealedScores = new Set();

// ÂM THANH TỰ ĐỘNG CHO WEB CHỦ
let soundContext = null;
let soundUnlocked = false;
let previousSoundPhase = null;
let previousSoundResult = "";
let countdownSoundEnd = null;
let countdownSoundLast = null;

function unlockSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!soundContext) soundContext = new AudioContextClass();
    if (soundContext.state === "suspended") soundContext.resume();
    soundUnlocked = true;
  } catch (error) {
    console.warn("Không thể bật âm thanh:", error);
  }
}

function playTone(frequency, duration = 0.13, type = "sine", volume = 0.045, delay = 0) {
  if (!soundUnlocked || !soundContext) return;
  const startAt = soundContext.currentTime + delay;
  const oscillator = soundContext.createOscillator();
  const gain = soundContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(soundContext.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

function playSequence(notes, type = "sine", volume = 0.05) {
  notes.forEach((note, index) => playTone(note, 0.16, type, volume, index * 0.14));
}

function playGameSound(kind) {
  if (!soundUnlocked) return;
  if (kind === "auctionStart") playSequence([520, 680, 880], "triangle", 0.045);
  else if (kind === "winner") playSequence([660, 830, 990, 1320], "sine", 0.055);
  else if (kind === "reveal") playSequence([440, 660, 880], "triangle", 0.04);
  else if (kind === "correct") playSequence([660, 830, 990, 1320], "sine", 0.055);
  else if (kind === "wrong") playSequence([330, 247, 185], "sawtooth", 0.035);
  else if (kind === "timeUp") playSequence([440, 330, 220], "square", 0.035);
  else if (kind === "finished") {
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((note, index) =>
      playTone(note, 0.22, "triangle", 0.055, index * 0.18)
    );
  }
}

function handleSoundState(state) {
  if (previousSoundPhase === null) {
    previousSoundPhase = state.phase;
    previousSoundResult = state.result
      ? `${state.currentIndex}:${state.result.selected}:${state.result.isCorrect}`
      : "";
    return;
  }
  if (state.phase !== previousSoundPhase) {
    if (state.phase === "auction") playGameSound("auctionStart");
    else if (state.phase === "winner") playGameSound("winner");
    else if (state.phase === "question") playGameSound("reveal");
    else if (state.phase === "answered" && state.result)
      playGameSound(state.result.isCorrect ? "correct" : "wrong");
    else if (state.phase === "finished") playGameSound("finished");
    previousSoundPhase = state.phase;
  }
  previousSoundResult = state.result
    ? `${state.currentIndex}:${state.result.selected}:${state.result.isCorrect}`
    : "";
}

const $ = id => document.getElementById(id);

async function api(url, method = "GET", body = null) {
  const options = {
    method,
    headers: {
      "x-admin-key": adminKey
    }
  };

  if (body !== null) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Có lỗi xảy ra.");
  }

  return data;
}

function notify(message) {
  alert(message);
}

async function login() {
  unlockSound();
  adminKey = $("adminKey").value.trim();

  if (!adminKey) {
    $("loginError").textContent = "Vui lòng nhập mã quản trị.";
    return;
  }

  try {
    const state = await api("/api/admin/state");
    sessionStorage.setItem("adminKey", adminKey);

    $("loginScreen").hidden = true;
    $("app").hidden = false;

    connectSocket();
    render(state);
  } catch (error) {
    $("loginError").textContent = "Mã quản trị không chính xác.";
  }
}

function connectSocket() {
  socket = io();

  socket.on("connect", () => {
    socket.emit("admin-connect", adminKey);
  });

  socket.on("admin-state", state => {
    render(state);
  });
}

function showPage(name) {
  document.querySelectorAll(".page").forEach(page => {
    page.hidden = true;
  });

  const page = $("page-" + name);
  if (page) page.hidden = false;

  if (name === "scores") renderRanking();
  if (name === "settings") renderSettings();
}

function render(state) {
  handleSoundState(state);
  currentState = state;
  renderHomeImage();

  $("gameTitle").textContent = state.settings.title;
  $("homeTitle").textContent = state.settings.title;
  $("questionCount").textContent =
    `Đã có ${state.questions.length} câu hỏi`;

  renderTeams();
  renderGame();
  renderRanking();
  renderDeviceManagement();
}

function renderTeams() {
  if (!currentState) return;

  $("homeTeams").innerHTML = currentState.settings.teams
    .map((name, i) => `
      <div class="team-card">
        <div class="team-number">TỔ ${i + 1}</div>
        <h3>${escapeHTML(name)}</h3>
        <div class="hidden-points">••••••</div>
      </div>
    `).join("");
}

function renderGame() {
  const s = currentState;
  if (!s) return;

  const q = s.question;

  $("topicLabel").textContent = q?.topic || "CHƯA CÓ CHỦ ĐỀ";
  $("questionNumber").textContent =
    `CÂU HỎI ${s.currentIndex + 1} / ${s.questions.length}`;

  const labels = {
    home: "TRANG CHỦ",
    ready: "SẴN SÀNG",
    auction: "ĐANG ĐẤU GIÁ",
    winner: "ĐÃ XÁC ĐỊNH TỔ THẮNG",
    question: "ĐANG TRẢ LỜI",
    answered: "ĐÃ TRẢ LỜI",
    finished: "ĐÃ KẾT THÚC",
    "no-bidders": "KHÔNG CÒN TỔ ĐỦ ĐIỂM"
  };

  $("phaseLabel").textContent = labels[s.phase] || s.phase;

  $("winnerName").textContent =
    s.winner ? s.winner.teamName : "Chưa xác định";

  const isOpenQuestion = q?.type === "open";
  if (s.revealed && q) {
    $("questionText").textContent = q.question;
    $("answerList").hidden = isOpenQuestion;
    $("openAnswerControls").hidden = !isOpenQuestion || s.phase !== "question";
    if (!isOpenQuestion) {
      ["A", "B", "C", "D"].forEach(letter => {
        $("answer" + letter).textContent = (q.answers || [])[["A", "B", "C", "D"].indexOf(letter)] || "";
      });
    }
  } else {
    $("questionText").textContent = "Câu hỏi sẽ được hiển thị sau khi tổ thắng được xác định.";
    $("answerList").hidden = true;
    $("openAnswerControls").hidden = true;
  }

  document.querySelectorAll(".answer").forEach(button => {
    button.classList.remove("correct", "wrong");
    button.disabled = s.phase !== "question";
  });
  $("answerResult").textContent = "";

  if (s.result) {
    if (s.result.type === "open") {
      const openAnswer = q?.openAnswer || "Chưa nhập đáp án mẫu cho câu hỏi này.";
      $("answerResult").textContent =
        (s.result.isCorrect ? "CHÍNH XÁC! TỔ ĐÃ TRẢ LỜI ĐÚNG.\n" : "CHƯA CHÍNH XÁC! TỔ TRẢ LỜI SAI.\n") +
        "ĐÁP ÁN THAM KHẢO: " + openAnswer;
    } else {
      const correct = s.result.correctAnswer;
      const selected = s.result.selected;
      const correctButton = document.querySelector(`.answer[data-answer="${correct}"]`);
      if (correctButton) correctButton.classList.add("correct");
      if (!s.result.isCorrect) {
        const wrongButton = document.querySelector(`.answer[data-answer="${selected}"]`);
        if (wrongButton) wrongButton.classList.add("wrong");
      }
      $("answerResult").textContent = s.result.isCorrect
        ? "CHÍNH XÁC! TỔ ĐÃ TRẢ LỜI ĐÚNG."
        : `CHƯA CHÍNH XÁC! ĐÁP ÁN ĐÚNG LÀ ${correct}.`;
    }
    $("answerResult").className = "result-message " + (s.result.isCorrect ? "success" : "failure");
  }

  $("startAuctionBtn").disabled =
    !["ready", "winner", "answered", "no-bidders"].includes(s.phase);

  $("revealBtn").disabled = s.phase !== "winner";
  $("nextBtn").disabled = s.phase !== "answered";

  if (s.phase === "auction") {
    startCountdown(s.auctionEndsAt);
  } else {
    stopCountdown();
    $("timer").textContent = "--";
  }
}

function startCountdown(endTime) {
  stopCountdown();

  if (countdownSoundEnd !== endTime) {
    countdownSoundEnd = endTime;
    countdownSoundLast = null;
  }

  function update() {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    $("timer").textContent = remaining;

    if (remaining <= 5 && remaining > 0 && remaining !== countdownSoundLast) {
      countdownSoundLast = remaining;
      playTone(remaining <= 3 ? 920 : 720, 0.085, "square", 0.035);
    }

    if (remaining <= 0) {
      $("timer").textContent = "0";
      if (countdownSoundLast !== 0) {
        countdownSoundLast = 0;
        playGameSound("timeUp");
      }
      stopCountdown();
    }
  }

  update();
  countdownInterval = setInterval(update, 200);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

async function startGame() {
  if (!confirm("Bắt đầu trò chơi và đặt lại điểm của cả 4 tổ?")) return;

  try {
    await api("/api/admin/start", "POST", {});
    showPage("game");
    notify("Đã bắt đầu trò chơi!");
  } catch (error) {
    notify(error.message);
  }
}

async function startAuction() {
  try {
    await api("/api/admin/auction/start", "POST", {});
  } catch (error) {
    notify(error.message);
  }
}

async function revealQuestion() {
  try {
    await api("/api/admin/reveal", "POST", {});
  } catch (error) {
    notify(error.message);
  }
}

async function chooseAnswer(letter) {
  if (!confirm(`Xác nhận đáp án ${letter}?`)) return;
  try {
    await api("/api/admin/answer", "POST", { answer: letter });
  } catch (error) {
    notify(error.message);
  }
}

async function markOpenAnswer(isCorrect) {
  const label = isCorrect ? "ĐÚNG" : "SAI";
  if (!confirm(`Xác nhận chấm câu tự luận là ${label}?`)) return;
  try {
    await api("/api/admin/answer", "POST", { isCorrect });
  } catch (error) {
    notify(error.message);
  }
}

async function nextQuestion() {
  if (!confirm("Chuyển sang câu hỏi tiếp theo?")) return;

  try {
    const result = await api("/api/admin/next", "POST", {});
    if (result.finished) {
      showPage("scores");
      notify("Đã hoàn thành toàn bộ câu hỏi!");
    }
  } catch (error) {
    notify(error.message);
  }
}

// CÀI ĐẶT
function renderSettings() {
  const s = currentState;
  if (!s) return;

  $("settingTitle").value = s.settings.title;
  $("settingDuration").value = s.settings.auctionSeconds;
  $("settingPoints").value = s.settings.startingPoints;

  $("teamSettings").innerHTML = s.settings.teams.map((name, i) => `
    <label>Tên tổ ${i + 1}</label>
    <input id="teamName${i}" value="${escapeHTML(name)}">
  `).join("");

  renderQuestionEditor();
}

async function saveSettings() {
  const teams = [0, 1, 2, 3].map(i =>
    $("teamName" + i).value.trim()
  );

  try {
    await api("/api/admin/settings", "POST", {
      title: $("settingTitle").value.trim(),
      auctionSeconds: Number($("settingDuration").value),
      startingPoints: Number($("settingPoints").value),
      teams
    });

    notify("Đã lưu cài đặt!");
  } catch (error) {
    notify(error.message);
  }
}

// NGÂN HÀNG CÂU HỎI
function readQuestionEditors() {
  return [...document.querySelectorAll(".question-editor")].map(editor => ({
    type: editor.querySelector(".q-type").value,
    topic: editor.querySelector(".q-topic").value,
    question: editor.querySelector(".q-text").value,
    openAnswer: editor.querySelector(".q-open-answer")?.value || "",
    answers: [...editor.querySelectorAll(".q-answer")].map(input => input.value),
    correct: editor.querySelector(".q-correct").value
  }));
}

function renderQuestionEditor() {
  const questions = currentState.questions || [];
  $("questionEditor").innerHTML = questions.map((q, i) => {
    const type = q.type === "open" ? "open" : "multiple";
    return `
    <div class="question-editor" data-index="${i}">
      <div class="section-heading">
        <h3>Câu ${i + 1} – ${type === "open" ? "TỰ LUẬN" : "TRẮC NGHIỆM"}</h3>
        <div>
          <button class="small" onclick="moveQuestion(${i}, -1)" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="small" onclick="moveQuestion(${i}, 1)" ${i === questions.length - 1 ? "disabled" : ""}>↓</button>
          <button class="danger small" onclick="deleteQuestion(${i})">XÓA</button>
        </div>
      </div>
      <label>Loại câu hỏi</label>
      <select class="q-type" onchange="changeQuestionType(${i}, this.value)">
        <option value="multiple" ${type === "multiple" ? "selected" : ""}>Trắc nghiệm</option>
        <option value="open" ${type === "open" ? "selected" : ""}>Tự luận</option>
      </select>
      <label>Chủ đề của câu hỏi</label>
      <input class="q-topic" value="${escapeHTML(q.topic || currentState.settings.topic || "")}" placeholder="Ví dụ: Lịch sử Việt Nam">
      <label>Nội dung câu hỏi</label>
      <textarea class="q-text">${escapeHTML(q.question || "")}</textarea>
      <div class="open-fields" ${type === "open" ? "" : "hidden"}>
        <label>Đáp án / Gợi ý trả lời (sẽ hiện sau khi chấm)</label>
        <textarea class="q-open-answer" placeholder="Nhập đáp án mẫu hoặc ý chính cần có">${escapeHTML(q.openAnswer || "")}</textarea>
      </div>
      <div class="mc-fields" ${type === "open" ? "hidden" : ""}>
        <div class="editor-answers">
          ${["A", "B", "C", "D"].map((letter, j) => `
            <div><label>Đáp án ${letter}</label>
              <input class="q-answer" data-letter="${letter}" value="${escapeHTML((q.answers || [])[j] || "")}">
            </div>`).join("")}
        </div>
        <label>Đáp án đúng</label>
        <select class="q-correct">
          ${["A", "B", "C", "D"].map(letter => `
            <option value="${letter}" ${q.correct === letter ? "selected" : ""}>${letter}</option>
          `).join("")}
        </select>
      </div>
    </div>`;
  }).join("");
}

function changeQuestionType(index, type) {
  const questions = readQuestionEditors();
  questions[index].type = type;
  currentState.questions = questions;
  renderQuestionEditor();
}

function addQuestion() {
  const questions = readQuestionEditors();
  questions.push({ type: "multiple", topic: "", question: "", openAnswer: "", answers: ["", "", "", ""], correct: "A" });
  currentState.questions = questions;
  renderQuestionEditor();
  const last = document.querySelector(".question-editor:last-child");
  if (last) last.scrollIntoView({ behavior: "smooth" });
}

function deleteQuestion(index) {
  if (!confirm(`Xóa câu hỏi số ${index + 1}?`)) return;
  const questions = readQuestionEditors();
  questions.splice(index, 1);
  currentState.questions = questions;
  renderQuestionEditor();
}

function moveQuestion(index, direction) {
  const questions = readQuestionEditors();
  const target = index + direction;
  if (target < 0 || target >= questions.length) return;
  [questions[index], questions[target]] = [questions[target], questions[index]];
  currentState.questions = questions;
  renderQuestionEditor();
}

async function saveQuestions() {
  const questions = readQuestionEditors().map(q => ({
    ...q,
    topic: q.topic.trim(),
    question: q.question.trim(),
    openAnswer: q.openAnswer.trim(),
    answers: q.type === "open" ? [] : q.answers.map(answer => answer.trim())
  }));
  try {
    await api("/api/admin/questions", "POST", { questions });
    notify("Đã lưu ngân hàng câu hỏi!");
  } catch (error) {
    notify(error.message);
  }
}

// BẢNG XẾP HẠNG
function renderRanking() {
  if (!currentState) return;

  const teams = currentState.settings.teams.map((name, i) => ({
    name,
    score: currentState.scores[i],
    index: i
  }));

  teams.sort((a, b) => b.score - a.score);

  $("rankingList").innerHTML = teams.map((team, rank) => `
    <div class="ranking-row">
      <span class="rank-number">${rank + 1}</span>
      <strong>${escapeHTML(team.name)}</strong>
      <button class="score-secret"
        onclick="revealScore(${team.index})">
        ${revealedScores.has(team.index) ? team.score.toLocaleString("vi-VN") : "NHẤN ĐỂ XEM"}
      </button>
    </div>
  `).join("");
}

function revealScore(index) {
  revealedScores.add(index);
  renderRanking();
}

async function endGame() {
  if (!confirm("Kết thúc trò chơi?")) return;

  try {
    await api("/api/admin/end", "POST", {});
    showPage("scores");
  } catch (error) {
    notify(error.message);
  }
}

// QUẢN LÝ THIẾT BỊ
function renderDeviceManagement() {
  $("deviceManagement").innerHTML =
    currentState.settings.teams.map((name, i) => `
      <div class="device-row">
        <span>${escapeHTML(name)}</span>
        <button class="danger small" onclick="releaseTeam(${i})">
          GIẢI PHÓNG THIẾT BỊ
        </button>
      </div>
    `).join("");
}

async function releaseTeam(index) {
  if (!confirm(`Cho phép thiết bị khác đăng nhập ${currentState.settings.teams[index]}?`)) return;

  try {
    await api("/api/admin/release-team", "POST", {
      teamIndex: index
    });
    notify("Đã giải phóng thiết bị.");
  } catch (error) {
    notify(error.message);
  }
}

// TRÌNH CHIẾU
async function uploadMedia() {
  const file = $("mediaFile").files[0];

  if (!file) {
    notify("Hãy chọn ảnh hoặc video trước.");
    return;
  }

  const form = new FormData();
  form.append("media", file);

  try {
    const response = await fetch("/api/admin/upload", {
      method: "POST",
      headers: { "x-admin-key": adminKey },
      body: form
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    mediaUrl = data.url;
    mediaType = data.type;

    renderMedia();
  } catch (error) {
    notify(error.message || "Không thể tải tệp lên.");
  }
}

function renderMedia() {
  if (!mediaUrl) return;

  $("mediaPreview").innerHTML = mediaType === "video"
    ? `<video controls src="${mediaUrl}"></video>`
    : `<img src="${mediaUrl}" alt="Ảnh trình chiếu">`;
}

function openPresentation() {
  if (!mediaUrl) {
    notify("Chưa có ảnh hoặc video để trình chiếu.");
    return;
  }

  $("presentation").hidden = false;

  $("presentationContent").innerHTML = mediaType === "video"
    ? `<video controls autoplay src="${mediaUrl}"></video>`
    : `<img src="${mediaUrl}" alt="Trình chiếu">`;
}

function closePresentation() {
  $("presentation").hidden = true;
  $("presentationContent").innerHTML = "";
}

// ẢNH TRANG CHỦ: tự tải lên Supabase và lưu đường dẫn vào game_state.
function renderHomeImage() {
  const url = currentState?.homeImageUrl;
  if (!url) {
    $("homeImagePreview").innerHTML = "";
    return;
  }

  $("homeImagePreview").innerHTML =
    `<img src="${escapeHTML(url)}" alt="Ảnh đại diện">`;
}

async function uploadHomeImage(file) {
  if (!file.type.startsWith("image/")) {
    notify("Vui lòng chọn tệp hình ảnh.");
    return;
  }

  $("homeImagePreview").textContent = "Đang tải ảnh lên Supabase...";

  const form = new FormData();
  form.append("media", file);
  form.append("purpose", "home");

  try {
    const response = await fetch("/api/admin/upload", {
      method: "POST",
      headers: { "x-admin-key": adminKey },
      body: form
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Không thể tải ảnh lên.");

    $("homeImagePreview").innerHTML =
      `<img src="${escapeHTML(data.url)}" alt="Ảnh đại diện">`;
    notify("Đã tải ảnh lên và lưu thành công!");
  } catch (error) {
    renderHomeImage();
    notify(error.message || "Không thể tải ảnh lên Supabase.");
  }
}

$("homeImage").addEventListener("change", event => {
  const file = event.target.files[0];
  if (file) uploadHomeImage(file);
});

// HỘP XÁC NHẬN DÙNG CHUNG
function askConfirm(message, callback) {
  $("confirmText").textContent = message;
  $("confirmDialog").hidden = false;

  $("confirmYes").onclick = () => {
    closeConfirm();
    callback();
  };
}

function closeConfirm() {
  $("confirmDialog").hidden = true;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// TỰ ĐĂNG NHẬP LẠI KHI TẢI TRANG
if (adminKey) {
  $("adminKey").value = adminKey;
  login();
}