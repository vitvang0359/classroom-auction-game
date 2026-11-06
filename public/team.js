let socket;
let teamToken = localStorage.getItem("teamToken") || "";
let myTeamIndex = null;
let currentState = null;
let countdown = null;
let draftTimeout = null;
let lastDraft = null;
let dialogAmount = 0;

const $ = id => document.getElementById(id);

async function request(url, method = "GET", body = null) {
  const options = {
    method,
    headers: {}
  };

  if (teamToken) {
    options.headers["x-team-token"] = teamToken;
  }

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

function showScreen(screen) {
  ["joinScreen", "auctionScreen", "questionScreen", "finishedScreen"]
    .forEach(id => $(id).hidden = id !== screen);
}

async function loadTeams() {
  try {
    const response = await fetch("/api/public/settings");
    const data = await response.json();

    $("mobileTitle").textContent = data.title;

    $("teamChoices").innerHTML = data.teams.map((name, i) => `
      <button class="team-choice" onclick="joinTeam(${i})">
        <span>TỔ ${i + 1}</span>
        <strong>${escapeHTML(name)}</strong>
      </button>
    `).join("");
  } catch (error) {
    $("joinError").textContent = "Không tải được danh sách tổ.";
  }
}

async function joinTeam(index) {
  try {
    const result = await request("/api/team/claim", "POST", {
      teamIndex: index
    });

    teamToken = result.token;
    myTeamIndex = result.teamIndex;

    localStorage.setItem("teamToken", teamToken);
    localStorage.setItem("teamIndex", myTeamIndex);

    connectSocket();
    await refreshState();
  } catch (error) {
    $("joinError").textContent = error.message;
  }
}

async function refreshState() {
  try {
    const state = await request("/api/team/state");
    render(state);
  } catch (error) {
    if (error.message.includes("Phiên tổ")) {
      localStorage.removeItem("teamToken");
      localStorage.removeItem("teamIndex");
      teamToken = "";
      myTeamIndex = null;
      showScreen("joinScreen");
      loadTeams();
    }
  }
}

function connectSocket() {
  if (socket) socket.disconnect();

  socket = io();

  socket.on("connect", () => {
    socket.emit("team-connect", teamToken);
    $("connectionStatus").textContent = "Đã kết nối";
    $("connectionStatus").classList.add("online");
  });

  socket.on("disconnect", () => {
    $("connectionStatus").textContent = "Mất kết nối – đang thử lại...";
    $("connectionStatus").classList.remove("online");
  });

  socket.on("team-state", state => {
    render(state);
  });
}

function render(state) {
  currentState = state;

  myTeamIndex = state.teamIndex;

  $("mobileTitle").textContent = state.settings.title;

  $("myTeamName").textContent = state.teamName;
  $("questionTeamName").textContent = state.teamName;

  $("myPoints").textContent = formatPoints(state.points);
  $("questionPoints").textContent = formatPoints(state.points);
  $("finalPoints").textContent = formatPoints(state.points);

  const q = state.question;

  if (state.ended || state.phase === "finished") {
    stopTimer();
    showScreen("finishedScreen");
    return;
  }

  if (state.phase === "question" || state.phase === "answered") {
    showScreen("questionScreen");
    renderQuestion(q);
    if (state.phase === "question" && state.answerEndsAt) {
      $("questionMobileTimer").parentElement.hidden = false;
      startTimer(state.answerEndsAt, "questionMobileTimer");
    } else {
      stopTimer();
      $("questionMobileTimer").textContent = "--";
      $("questionMobileTimer").parentElement.hidden = true;
    }
    $("answerTurnStatus").textContent = state.activeResponder
      ? (!state.answerEndsAt
          ? "ĐẾN LƯỢT " + state.activeResponder.teamName + " – ĐANG CHỜ QUẢN TRÒ BẮT ĐẦU TÍNH GIỜ."
          : "ĐẾN LƯỢT TRẢ LỜI: " + state.activeResponder.teamName)
      : (state.phase === "answered" ? "CÂU HỎI ĐÃ KẾT THÚC." : "Đang chờ đội trả lời.");
    return;
  }

  showScreen("auctionScreen");

  $("mobileQuestionNumber").textContent =
    `CÂU ${q?.number || 1} / ${q?.total || 1}`;

  $("mobileTopic").textContent = q?.topic || "Chưa có chủ đề";
  $("mobilePhase").textContent = phaseText(state.phase);

  const bid = state.myBid;

  $("bidInput").value = bid ? bid.amount : "";
  lastDraft = bid ? bid.amount : null;

  const isAuction = state.phase === "auction";
  const locked = Boolean(bid?.locked);

  $("bidArea").hidden = !isAuction || locked;
  $("waitingArea").hidden = !isAuction || !locked;
  $("winnerArea").hidden = state.phase !== "winner" ||
    state.winner?.teamIndex !== myTeamIndex;
  $("loserArea").hidden = state.phase !== "winner" ||
    state.winner?.teamIndex === myTeamIndex;
  $("noBidArea").hidden = state.phase !== "no-bidders";

  $("confirmBidBtn").disabled = locked || !isAuction;
  $("bidInput").disabled = locked || !isAuction;

  if (locked) {
    $("bidStatus").textContent = "Giá đấu đã được chốt.";
  } else if (bid) {
    $("bidStatus").textContent = "Giá nháp đã được lưu.";
  } else {
    $("bidStatus").textContent = "Chưa nhập giá đấu.";
  }

  if (isAuction) {
    startTimer(state.auctionEndsAt, "mobileTimer");
  } else {
    stopTimer();
    $("mobileTimer").textContent = "--";
  }
}

function phaseText(phase) {
  const labels = {
    home: "CHƯA BẮT ĐẦU",
    ready: "CHỜ ĐẤU GIÁ",
    auction: "ĐANG ĐẤU GIÁ",
    winner: "ĐÃ CÓ TỔ THẮNG",
    question: "ĐANG TRẢ LỜI",
    answered: "ĐÃ TRẢ LỜI",
    "no-bidders": "KHÔNG CÓ TỔ ĐỦ ĐIỂM",
    finished: "ĐÃ KẾT THÚC"
  };

  return labels[phase] || phase;
}

function renderQuestion(q) {
  if (!q || !q.question) return;
  $("viewQuestionNumber").textContent = `CÂU ${q.number} / ${q.total}`;
  $("viewTopic").textContent = q.topic || "Chưa có chủ đề";
  $("viewQuestion").textContent = q.question;
  const isOpen = q.type === "open";
  $("viewQuestionType").textContent = isOpen ? "CÂU TỰ LUẬN" : "CÂU TRẮC NGHIỆM";
  $("viewAnswers").hidden = isOpen;
  $("viewAnswers").innerHTML = isOpen ? "" : (q.answers || []).map((answer, i) => `
    <div class="mobile-answer">
      <strong>${["A", "B", "C", "D"][i]}</strong>
      <span>${escapeHTML(answer)}</span>
    </div>
  `).join("");

  let answerBox = document.getElementById("viewOpenAnswer");
  if (!answerBox) {
    answerBox = document.createElement("div");
    answerBox.id = "viewOpenAnswer";
    answerBox.className = "mobile-answer";
    $("viewAnswers").insertAdjacentElement("afterend", answerBox);
  }
  answerBox.hidden = !isOpen || !q.openAnswer;
  answerBox.textContent = isOpen && q.openAnswer
    ? "ĐÁP ÁN THAM KHẢO: " + q.openAnswer
    : "";
}

function startTimer(endTime, elementId = "mobileTimer") {
  stopTimer();

  function update() {
    const seconds = Math.max(
      0,
      Math.ceil((endTime - Date.now()) / 1000)
    );

    $(elementId).textContent = seconds;

    if (seconds <= 0) {
      stopTimer();
      $(elementId).textContent = "0";
    }
  }

  update();
  countdown = setInterval(update, 200);
}

function stopTimer() {
  if (countdown) {
    clearInterval(countdown);
    countdown = null;
  }
}

// LƯU GIÁ NHÁP LÊN MÁY CHỦ
$("bidInput").addEventListener("input", () => {
  clearTimeout(draftTimeout);

  const amount = Number($("bidInput").value);

  if (!currentState || currentState.phase !== "auction") return;

  if (!Number.isInteger(amount) ||
      amount <= 0 ||
      amount % 10 !== 0 ||
      amount > currentState.points) {
    $("bidStatus").textContent =
      "Giá không hợp lệ. Hãy nhập bội số của 10.";
    return;
  }

  $("bidStatus").textContent = "Đang lưu giá nháp...";

  draftTimeout = setTimeout(async () => {
    try {
      await request("/api/team/draft", "POST", { amount });
      lastDraft = amount;
      $("bidStatus").textContent = "Giá nháp đã được lưu.";
    } catch (error) {
      $("bidStatus").textContent = error.message;
    }
  }, 250);
});

function askBidConfirm() {
  const amount = Number($("bidInput").value);

  if (!Number.isInteger(amount) ||
      amount <= 0 ||
      amount % 10 !== 0 ||
      amount > currentState.points) {
    alert("Giá đấu không hợp lệ!");
    return;
  }

  dialogAmount = amount;

  $("bidConfirmText").textContent =
    `Bạn muốn chốt giá ${formatPoints(amount)} điểm? Sau khi xác nhận, bạn không thể sửa giá.`;

  $("bidDialog").hidden = false;
}

function closeBidDialog() {
  $("bidDialog").hidden = true;
}

async function confirmBid() {
  closeBidDialog();

  try {
    // Đảm bảo giá mới nhất đã được lưu trước khi chốt.
    await request("/api/team/draft", "POST", {
      amount: dialogAmount
    });

    await request("/api/team/confirm", "POST", {});

    $("bidStatus").textContent = "Đã chốt giá thành công!";
    await refreshState();
  } catch (error) {
    alert(error.message);
  }
}

function formatPoints(value) {
  return Number(value || 0).toLocaleString("vi-VN");
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

// TỰ KHÔI PHỤC PHIÊN ĐĂNG NHẬP
async function restoreSession() {
  if (!teamToken) {
    showScreen("joinScreen");
    await loadTeams();
    return;
  }

  try {
    await refreshState();
    connectSocket();
  } catch (error) {
    showScreen("joinScreen");
    await loadTeams();
  }
}

restoreSession();