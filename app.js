'use strict';

/* ============================================================
   RUNG CHUÔNG VÀNG v3 — Student App (Phòng Máy / Online)
   Deploy riêng trên Vercel, học sinh vào bằng QR hoặc link.
   Luồng: nhập mã phòng → chọn tên → chờ → câu hỏi → kết quả
   ============================================================ */

const SESSION_STATUS = {
    WAITING: 'WAITING', CONNECTED: 'CONNECTED',
    QUESTION_ACTIVE: 'QUESTION_ACTIVE', QUESTION_LOCKED: 'QUESTION_LOCKED',
    QUESTION_RESULT: 'QUESTION_RESULT', COMPLETED: 'COMPLETED', RANKING: 'RANKING'
};

const appState = {
    roomCode: null,
    session: null,
    myStudentId: null,
    myStudentName: null,
    countdownTimer: null,
    myAnswer: null,
    questionAnswered: false,
    sessionDataReady: false,
    myTotalScore: 0,
    myCorrect: 0
};

/* ===== UTILS ===== */
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function showView(id) {
    $$('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + id)?.classList.add('active');
}
function getCurrentQuestion(s) { return s?.questions?.[s.currentQuestionIndex] || null; }

/* ===== PEERJS SYNC ===== */
const Sync = {
    peer: null, conn: null, onMsg: null,
    reconnectLoop: null, pollLoop: null,

    connect(roomCode) {
        return new Promise(resolve => {
            const hostId = 'pm-' + roomCode;
            try {
                this.peer?.destroy();
                this.peer = new Peer(undefined, {
                    debug: 1,
                    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
                });
                this.peer.on('open', () => {
                    const conn = this.peer.connect(hostId, { reliable: true });
                    let done = false;
                    const finish = ok => { if (!done) { done = true; resolve(ok); } };
                    conn.on('open',  () => { this.conn = conn; conn.on('data', d => this._handle(d)); finish(true); });
                    conn.on('error', () => finish(false));
                    setTimeout(() => finish(false), 10000);
                });
                this.peer.on('error', () => resolve(false));
            } catch { resolve(false); }
        });
    },

    _handle(msg) { if (this.onMsg) this.onMsg(msg); },
    send(msg)    { if (this.conn?.open) this.conn.send(msg); },
    destroy()    {
        clearInterval(this.reconnectLoop);
        clearInterval(this.pollLoop);
        this.conn?.close(); this.peer?.destroy();
        this.conn = null; this.peer = null;
    }
};

/* ===== ENTRY ===== */
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');

    if (roomParam) {
        // Vào thẳng từ link / QR
        joinRoom(roomParam.toUpperCase());
    } else {
        showView('enter-code');
    }

    // Nút vào phòng
    $('#btn-join-room')?.addEventListener('click', () => {
        const code = ($('#room-code-input')?.value || '').trim().toUpperCase();
        if (!code) { setStatus('enter-code', 'Nhập mã phòng', 'error'); return; }
        joinRoom(code);
    });
    $('#room-code-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') $('#btn-join-room')?.click();
    });
});

/* ===== JOIN ROOM ===== */
async function joinRoom(code) {
    appState.roomCode = code;
    setStatus('enter-code', 'Đang kết nối tới phòng ' + code + '...', '');
    showView('enter-code');

    Sync.onMsg = handleMessage;
    const ok = await Sync.connect(code);

    if (!ok) {
        setStatus('enter-code', '❌ Không tìm thấy phòng "' + code + '". Kiểm tra mã và thử lại.', 'error');
        return;
    }

    // Kết nối OK — xin trạng thái
    Sync.send({ type: 'REQUEST_STATE' });

    // Poll định kỳ cho đến khi nhận được data
    Sync.pollLoop = setInterval(() => {
        if (appState.sessionDataReady) { clearInterval(Sync.pollLoop); return; }
        Sync.send({ type: 'REQUEST_STATE' });
    }, 2000);

    // Reconnect nếu mất kết nối
    Sync.reconnectLoop = setInterval(async () => {
        if (Sync.conn?.open) return;
        const r = await Sync.connect(code);
        if (r) { Sync.send({ type: 'REQUEST_STATE' }); }
    }, 8000);
}

/* ===== MESSAGE HANDLER ===== */
function handleMessage(msg) {
    if (!msg?.type) return;
    const prevStatus = appState.session?.status;
    const prevQIdx   = appState.session?.currentQuestionIndex;

    if (msg.session) {
        appState.session = JSON.parse(JSON.stringify(msg.session));
        appState.sessionDataReady = true;
    }

    const s = appState.session;
    if (!s) return;

    // Nhận xong danh sách HS → hiện picker tên nếu chưa chọn
    if (!appState.myStudentId && s.students?.length) {
        showPickName(s);
        return;
    }

    const qChanged = s.currentQuestionIndex !== prevQIdx || s.status !== prevStatus;

    switch (msg.type) {
        case 'STATE_SYNC':
        case 'SESSION_CREATED':
            routeByStatus(s);
            break;

        case 'QUESTION_CHANGED':
        case 'NEXT_QUESTION':
            // Câu mới → reset đáp án
            appState.myAnswer = null;
            appState.questionAnswered = false;
            if (appState.myStudentId) showQuestion(s);
            break;

        case 'QUESTION_RESULT':
        case 'QUESTION_LOCKED':
            stopCountdown();
            if (appState.myStudentId) showResult(s);
            break;

        case 'SESSION_COMPLETED':
            stopCountdown();
            showEnded(s);
            break;

        default:
            if (qChanged && appState.myStudentId) routeByStatus(s);
    }
}

function routeByStatus(s) {
    if (!appState.myStudentId) { showPickName(s); return; }
    switch (s.status) {
        case SESSION_STATUS.WAITING:
        case SESSION_STATUS.CONNECTED:
            showWaiting();
            break;
        case SESSION_STATUS.QUESTION_ACTIVE:
            showQuestion(s);
            break;
        case SESSION_STATUS.QUESTION_RESULT:
        case SESSION_STATUS.QUESTION_LOCKED:
            stopCountdown();
            showResult(s);
            break;
        case SESSION_STATUS.COMPLETED:
        case SESSION_STATUS.RANKING:
            stopCountdown();
            showEnded(s);
            break;
    }
}

/* ===== PICK NAME ===== */
function showPickName(session) {
    showView('pick-name');
    $('#pick-room-badge').textContent = 'Phòng: ' + (appState.roomCode || session.id);
    setStatus('pick-name', '', '');

    const taken = new Set(Object.keys(session.onlineStudents || {}));
    const grid = $('#student-name-list');
    if (!grid) return;

    grid.innerHTML = session.students.map(st => {
        const isTaken = taken.has(st.id) && st.id !== appState.myStudentId;
        return `<button class="sv-name-btn${isTaken ? ' taken' : ''}"
                    data-id="${st.id}" data-name="${esc(st.name)}"
                    ${isTaken ? 'disabled' : ''}>
                    ${esc(st.name)}
                </button>`;
    }).join('');

    grid.querySelectorAll('.sv-name-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => pickName(btn.dataset.id, btn.dataset.name));
    });
}

function pickName(id, name) {
    appState.myStudentId = id;
    appState.myStudentName = name;

    // Thông báo host
    Sync.send({
        type: 'STUDENT_JOINED',
        studentId: id,
        name: name,
        roomCode: appState.roomCode
    });

    // Nếu game đã active → show câu ngay
    const s = appState.session;
    if (s?.status === SESSION_STATUS.QUESTION_ACTIVE) {
        appState.myAnswer = null;
        appState.questionAnswered = false;
        showQuestion(s);
    } else {
        showWaiting();
    }
}

/* ===== WAITING ===== */
function showWaiting() {
    showView('waiting');
    $('#wait-room-badge').textContent  = 'Phòng: ' + (appState.roomCode || appState.session?.id || '—');
    $('#wait-student-name').textContent = appState.myStudentName || '—';
}

/* ===== QUESTION ===== */
function showQuestion(session) {
    const q = getCurrentQuestion(session);
    if (!q) return;

    showView('question');
    const qIdx   = session.currentQuestionIndex;
    const qTotal = session.questions.length;

    $('#q-room-info').textContent  = 'Phòng: ' + (appState.roomCode || session.id);
    $('#q-num-label').textContent  = `Câu ${qIdx + 1}/${qTotal}`;
    $('#sv-submitted-banner').classList.add('hidden');
    $('#sv-status-bar').textContent = '';

    // Câu hỏi
    $('#sv-question-text').textContent = q.question || '';
    const imgEl = $('#sv-question-image');
    if (imgEl) imgEl.innerHTML = q.questionImage ? `<img src="${q.questionImage}" alt="">` : '';

    // Đáp án
    const answersEl = $('#sv-answers');
    if (answersEl) {
        answersEl.innerHTML = ['A','B','C','D'].map(letter => {
            const ans = q.answers?.find(a => a.id === letter) || { text: '' };
            const sel = appState.myAnswer === letter ? ' selected' : '';
            return `<button class="sv-ans-btn ${letter}${sel}" data-letter="${letter}">
                        <span class="sv-ans-badge">${letter}</span>
                        <span class="sv-ans-text">${esc(ans.text)}</span>
                    </button>`;
        }).join('');

        answersEl.querySelectorAll('.sv-ans-btn').forEach(btn => {
            btn.addEventListener('click', () => onAnswer(btn.dataset.letter, session));
        });
    }

    // Nếu đã nộp rồi → lock lại
    const existing = session.answers?.find(
        a => a.questionId === q.id && a.studentId === appState.myStudentId
    );
    if (existing?.answer) {
        appState.myAnswer = existing.answer;
        appState.questionAnswered = true;
        showSubmittedBanner(existing.answer);
        disableButtons();
        stopCountdown();
    } else {
        // Bắt đầu đếm ngược
        startCountdown(session.gameSettings?.timePerQuestion || 15);
    }
}

function onAnswer(letter, session) {
    if (appState.questionAnswered) return;
    appState.myAnswer = letter;
    appState.questionAnswered = true;

    // Highlight
    $$('.sv-ans-btn').forEach(b => b.classList.toggle('selected', b.dataset.letter === letter));
    disableButtons();
    showSubmittedBanner(letter);
    stopCountdown();

    // Gửi về host
    const q = getCurrentQuestion(session);
    Sync.send({
        type: 'ANSWER_SCANNED',
        studentId: appState.myStudentId,
        answer: letter,
        questionId: q?.id,
        submittedAt: Date.now(),
        questionStartedAt: session._qStartedAt || null
    });

    $('#sv-status-bar').textContent = '✓ Đã gửi đáp án';
}

function showSubmittedBanner(letter) {
    const b = $('#sv-submitted-banner');
    if (b) { b.classList.remove('hidden'); $('#sv-submitted-text').textContent = `✅ Đã chọn: ${letter}`; }
}
function disableButtons() { $$('.sv-ans-btn').forEach(b => { b.disabled = true; }); }

/* ===== COUNTDOWN ===== */
function startCountdown(seconds) {
    stopCountdown();
    let left = seconds;
    const C = 2 * Math.PI * 14; // r=14 → 87.96

    const tick = () => {
        const numEl  = $('#sv-countdown');
        const ringEl = $('#sv-ring-fill');
        if (numEl)  numEl.textContent = left;
        if (ringEl) {
            ringEl.style.strokeDashoffset = C * (1 - left / seconds);
            ringEl.classList.toggle('urgent', left <= 5);
        }
    };

    tick();
    appState.countdownTimer = setInterval(() => {
        left--;
        tick();
        if (left <= 0) stopCountdown();
    }, 1000);
}

function stopCountdown() {
    if (appState.countdownTimer) { clearInterval(appState.countdownTimer); appState.countdownTimer = null; }
}

/* ===== RESULT ===== */
function showResult(session) {
    const q = getCurrentQuestion(session);
    if (!q) return;

    showView('result');
    const qIdx   = session.currentQuestionIndex;
    const qTotal = session.questions.length;

    $('#res-room-info').textContent = 'Phòng: ' + (appState.roomCode || session.id);
    $('#res-num-label').textContent = `Câu ${qIdx + 1}/${qTotal}`;

    const myAns    = appState.myAnswer;
    const isCorrect = myAns === q.correctAnswer;
    const noAns    = !myAns;

    // Banner
    const banner = $('#sv-result-banner');
    if (banner) {
        if (noAns)      { banner.textContent = '⏰ Hết giờ!';                 banner.className = 'sv-result-banner timeout'; }
        else if (isCorrect) { banner.textContent = '✅ CHÍNH XÁC!';            banner.className = 'sv-result-banner correct'; }
        else                { banner.textContent = `❌ Sai! Đúng là: ${q.correctAnswer}`; banner.className = 'sv-result-banner wrong'; }
    }

    // 4 đáp án với highlight
    const resEl = $('#sv-result-answers');
    if (resEl) {
        resEl.innerHTML = ['A','B','C','D'].map(letter => {
            const ans = q.answers?.find(a => a.id === letter) || { text: '' };
            const isCorrectAns = letter === q.correctAnswer;
            const isMyWrong    = letter === myAns && !isCorrectAns;
            const cls = isCorrectAns ? 'correct-ans' : isMyWrong ? 'my-ans-wrong' : 'other';
            return `<div class="sv-res-ans-item ${cls}">
                        <span class="sv-res-badge ${letter}">${letter}</span>
                        <span>${esc(ans.text)}</span>
                        ${isCorrectAns ? '<span style="margin-left:auto">✅</span>' : ''}
                        ${isMyWrong    ? '<span style="margin-left:auto">👈</span>' : ''}
                    </div>`;
        }).join('');
    }

    // Cộng điểm
    if (isCorrect) {
        const cfg = session.gameSettings || {};
        if (cfg.scoringMode === 'by_time') {
            const totalMs  = (cfg.timePerQuestion || 15) * 1000;
            const ans      = session.answers?.find(a => a.questionId === q.id && a.studentId === appState.myStudentId);
            const elapsed  = ans?.questionStartedAt ? (ans.submittedAt - ans.questionStartedAt) : totalMs / 2;
            const frac     = Math.max(0, Math.min(1, 1 - elapsed / totalMs));
            const pts      = Math.round((cfg.basePoints || 500) + ((cfg.maxPoints || 1000) - (cfg.basePoints || 500)) * frac);
            appState.myTotalScore += pts;
        } else {
            appState.myTotalScore += 1;
        }
        appState.myCorrect++;
    }

    const scoreEl = $('#sv-score-val');
    if (scoreEl) {
        const isTime = session.gameSettings?.scoringMode === 'by_time';
        scoreEl.textContent = isTime ? appState.myTotalScore : `${appState.myCorrect}/${qTotal}`;
    }
}

/* ===== ENDED ===== */
function showEnded(session) {
    showView('ended');
    $('#end-student-name').textContent = appState.myStudentName || '—';

    const qTotal   = session?.questions?.length || 0;
    const isTime   = session?.gameSettings?.scoringMode === 'by_time';
    const scoreStr = isTime ? appState.myTotalScore : `${appState.myCorrect}/${qTotal}`;
    $('#end-score-val').textContent = scoreStr;

    const wrong    = qTotal - appState.myCorrect;
    const noAns    = qTotal - appState.myCorrect - wrong; // simplified
    const corEl = $('#end-correct-info');
    if (corEl) corEl.textContent = `Đúng: ${appState.myCorrect} · Sai: ${qTotal - appState.myCorrect}`;
}

/* ===== HELPERS ===== */
function setStatus(viewId, msg, type) {
    const map = { 'enter-code': '#enter-code-status', 'pick-name': '#pick-name-status' };
    const el  = $(map[viewId]);
    if (!el) return;
    el.textContent  = msg;
    el.className    = 'sv-status' + (type ? ' ' + type : '');
}
