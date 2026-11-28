'use strict';

/* ============================================================
   RUNG CHUÔNG VÀNG v3 — Student App (Phòng Máy / Online)
   Deploy: https://rung-chuong.vercel.app
   Flow: ?room=CODE → kết nối PeerJS → chọn tên → thi A/B/C/D
   ============================================================ */

const SESSION_STATUS = {
    WAITING:'WAITING', CONNECTED:'CONNECTED',
    QUESTION_ACTIVE:'QUESTION_ACTIVE', QUESTION_LOCKED:'QUESTION_LOCKED',
    QUESTION_RESULT:'QUESTION_RESULT', COMPLETED:'COMPLETED', RANKING:'RANKING'
};

const appState = {
    roomCode: null,
    session: null,
    myStudentId: null,
    myStudentName: null,
    countdownTimer: null,
    countdownEndTime: 0,       // timestamp khi hết giờ
    myAnswer: null,
    questionAnswered: false,
    sessionDataReady: false,
    myTotalScore: 0,
    myCorrect: 0,
    currentQId: null           // track câu đang hiển thị
};

/* ===== UTILS ===== */
function $(s){ return document.querySelector(s); }
function $$(s){ return document.querySelectorAll(s); }
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function getCurrentQuestion(s){ return s?.questions?.[s.currentQuestionIndex] || null; }

function showView(id){
    $$('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + id)?.classList.add('active');
}

/* ===== SOUND (simple, mobile-safe) ===== */
const Sound = {
    _ctx: null,
    _get() {
        if (!this._ctx) {
            try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(_){}
        }
        if (this._ctx?.state === 'suspended') this._ctx.resume().catch(()=>{});
        return this._ctx;
    },
    beep(freq, dur, type='sine', vol=0.15) {
        try {
            const ctx = this._get(); if (!ctx) return;
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.type = type; o.frequency.value = freq;
            const now = ctx.currentTime;
            g.gain.setValueAtTime(vol, now);
            g.gain.exponentialRampToValueAtTime(0.001, now + dur);
            o.start(now); o.stop(now + dur);
        } catch(_){}
    },
    play(type) {
        const map = {
            correct:  () => { this.beep(523,.1,'triangle',.18); setTimeout(()=>this.beep(659,.1,'triangle',.18),80); setTimeout(()=>this.beep(784,.15,'triangle',.18),160); setTimeout(()=>this.beep(1047,.4,'triangle',.18),250); },
            wrong:    () => { this.beep(400,.15,'sawtooth',.12); setTimeout(()=>this.beep(300,.15,'sawtooth',.1),120); setTimeout(()=>this.beep(220,.3,'sawtooth',.08),250); },
            scan:     () => { this.beep(880,.08,'sine',.15); setTimeout(()=>this.beep(1200,.1,'sine',.12),80); },
            tick:     () => { this.beep(1200,.05,'square',.08); },
            urgent:   () => { this.beep(880,.08,'square',.1); setTimeout(()=>this.beep(880,.08,'square',.08),150); },
            bell:     () => { this.beep(783,.2,'sine',.2); setTimeout(()=>this.beep(1046,.2,'sine',.2),160); setTimeout(()=>this.beep(1318,.5,'sine',.18),320); },
        };
        map[type]?.();
    }
};

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
                    debug: 0,
                    config: { iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]}
                });
                this.peer.on('open', () => {
                    const conn = this.peer.connect(hostId, { reliable: true });
                    let done = false;
                    const finish = ok => { if (!done) { done = true; resolve(ok); } };
                    conn.on('open', () => {
                        this.conn = conn;
                        conn.on('data', d => { if (this.onMsg) this.onMsg(d); });
                        conn.on('close', () => {
                            this.conn = null;
                            // Tự reconnect sau 2s
                            setTimeout(() => this._tryReconnect(roomCode), 2000);
                        });
                        finish(true);
                    });
                    conn.on('error', () => finish(false));
                    setTimeout(() => finish(false), 12000);
                });
                this.peer.on('error', () => resolve(false));
            } catch { resolve(false); }
        });
    },

    _tryReconnect(code) {
        if (this.conn?.open) return;
        this.connect(code).then(ok => {
            if (ok) this.send({ type: 'REQUEST_STATE' });
        });
    },

    send(msg) { if (this.conn?.open) this.conn.send(msg); },

    destroy() {
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
        joinRoom(roomParam.toUpperCase());
    } else {
        showView('enter-code');
    }

    $('#btn-join-room')?.addEventListener('click', () => {
        const code = ($('#room-code-input')?.value || '').trim().toUpperCase();
        if (!code) { setStatus('enter-code', 'Nhập mã phòng!', 'error'); return; }
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

    Sync.onMsg = handleMessage;
    const ok = await Sync.connect(code);

    if (!ok) {
        setStatus('enter-code', '❌ Không tìm thấy phòng "' + code + '". Kiểm tra mã và thử lại.', 'error');
        return;
    }

    // Kết nối OK — xin state ngay
    Sync.send({ type: 'REQUEST_STATE' });

    // Poll mỗi 1.5s — đảm bảo luôn đồng bộ, dừng khi đã vào game
    Sync.pollLoop = setInterval(() => {
        if (!Sync.conn?.open) return;
        // Chỉ poll khi chưa vào câu hỏi (tránh nhiễu khi đang thi)
        const status = appState.session?.status;
        if (status === SESSION_STATUS.QUESTION_ACTIVE || status === SESSION_STATUS.COMPLETED) return;
        Sync.send({ type: 'REQUEST_STATE' });
    }, 2000);

    // Reconnect loop ngoài
    Sync.reconnectLoop = setInterval(async () => {
        if (Sync.conn?.open) return;
        const r = await Sync.connect(code);
        if (r) Sync.send({ type: 'REQUEST_STATE' });
    }, 8000);
}

/* ===== MESSAGE HANDLER ===== */
function handleMessage(msg) {
    if (!msg?.type) return;

    const prevStatus = appState.session?.status;
    const prevQIdx   = appState.session?.currentQuestionIndex;

    // Merge session mới
    if (msg.session) {
        appState.session = JSON.parse(JSON.stringify(msg.session));
        appState.sessionDataReady = true;
    }

    const s = appState.session;
    if (!s?.students?.length) return;

    // Chưa chọn tên → hiện picker
    if (!appState.myStudentId) {
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
            appState.currentQId = getCurrentQuestion(s)?.id || null;
            showQuestion(s);
            break;

        case 'QUESTION_RESULT':
        case 'QUESTION_LOCKED':
            stopCountdown();
            showResult(s);
            break;

        case 'SESSION_COMPLETED':
            stopCountdown();
            showEnded(s);
            break;

        default:
            if (qChanged) routeByStatus(s);
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
            // Chỉ show câu hỏi nếu là câu mới hoặc chưa đang show
            if (appState.currentQId !== getCurrentQuestion(s)?.id) {
                appState.myAnswer = null;
                appState.questionAnswered = false;
                appState.currentQId = getCurrentQuestion(s)?.id || null;
            }
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
        btn.addEventListener('click', () => {
            Sound.play('scan');
            pickName(btn.dataset.id, btn.dataset.name);
        });
    });
}

function pickName(id, name) {
    appState.myStudentId = id;
    appState.myStudentName = name;

    Sync.send({ type: 'STUDENT_JOINED', studentId: id, name, roomCode: appState.roomCode });

    const s = appState.session;
    if (s?.status === SESSION_STATUS.QUESTION_ACTIVE) {
        appState.myAnswer = null;
        appState.questionAnswered = false;
        appState.currentQId = getCurrentQuestion(s)?.id || null;
        showQuestion(s);
    } else if (s?.status === SESSION_STATUS.QUESTION_RESULT || s?.status === SESSION_STATUS.QUESTION_LOCKED) {
        showResult(s);
    } else if (s?.status === SESSION_STATUS.COMPLETED) {
        showEnded(s);
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
    const timePerQ = session.gameSettings?.timePerQuestion || 15;

    $('#q-room-info').textContent  = 'Phòng: ' + (appState.roomCode || session.id);
    $('#q-num-label').textContent  = `Câu ${qIdx + 1}/${qTotal}`;
    $('#sv-submitted-banner').classList.add('hidden');
    $('#sv-status-bar').textContent = '';

    // Nội dung câu hỏi
    $('#sv-question-text').textContent = q.question || '';
    const imgEl = $('#sv-question-image');
    if (imgEl) imgEl.innerHTML = q.questionImage ? `<img src="${q.questionImage}" alt="">` : '';

    // 4 đáp án
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

        // Bind click — dùng appState.session để luôn có session mới nhất
        answersEl.querySelectorAll('.sv-ans-btn').forEach(btn => {
            btn.addEventListener('click', () => onAnswer(btn.dataset.letter));
        });
    }

    // Nếu đã nộp rồi (từ state sync) → lock
    const existing = session.answers?.find(
        a => a.questionId === q.id && a.studentId === appState.myStudentId
    );
    if (existing?.answer) {
        appState.myAnswer = existing.answer;
        appState.questionAnswered = true;
        showSubmittedBanner(existing.answer);
        disableButtons();
        stopCountdown();
        // Vẫn hiện countdown đếm ngược thời gian còn lại dựa vào _qStartedAt
        if (session._qStartedAt) {
            const elapsed = Date.now() - session._qStartedAt;
            const remaining = Math.max(0, timePerQ - Math.floor(elapsed / 1000));
            if (remaining > 0) startCountdown(remaining, timePerQ);
        }
    } else {
        // Tính remaining từ _qStartedAt nếu có
        if (session._qStartedAt) {
            const elapsed = Date.now() - session._qStartedAt;
            const remaining = Math.max(1, timePerQ - Math.floor(elapsed / 1000));
            startCountdown(remaining, timePerQ);
        } else {
            startCountdown(timePerQ, timePerQ);
        }
    }
}

/* ===== ANSWER ===== */
function onAnswer(letter) {
    if (appState.questionAnswered) return;

    const session = appState.session;
    if (!session) return;

    const q = getCurrentQuestion(session);
    if (!q) return;

    // Kiểm tra session vẫn còn active
    if (session.status !== SESSION_STATUS.QUESTION_ACTIVE) return;

    appState.myAnswer = letter;
    appState.questionAnswered = true;

    // Visual feedback ngay lập tức
    $$('.sv-ans-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.letter === letter);
    });
    disableButtons();
    showSubmittedBanner(letter);
    stopCountdown();
    Sound.play('scan');

    // Gửi về host
    Sync.send({
        type: 'ANSWER_SCANNED',
        studentId: appState.myStudentId,
        answer: letter,
        questionId: q.id,
        submittedAt: Date.now(),
        questionStartedAt: session._qStartedAt || null
    });

    $('#sv-status-bar').textContent = '✓ Đã gửi đáp án thành công';
}

function showSubmittedBanner(letter) {
    const b = $('#sv-submitted-banner');
    if (!b) return;
    b.classList.remove('hidden');
    $('#sv-submitted-text').textContent = `✅ Đã chọn: ${letter}`;
}

function disableButtons() {
    $$('.sv-ans-btn').forEach(b => { b.disabled = true; });
}

/* ===== COUNTDOWN — dùng requestAnimationFrame, chống throttle ===== */
function startCountdown(seconds, totalSeconds) {
    stopCountdown();
    if (seconds <= 0) return;

    const total = totalSeconds || seconds;
    const endTime = Date.now() + seconds * 1000;
    const C = 2 * Math.PI * 14; // r=14 → 87.96

    // Dùng rAF thay vì setInterval để không bị throttle
    let lastSecond = seconds;

    const frame = () => {
        const remaining = Math.max(0, (endTime - Date.now()) / 1000);
        const leftInt = Math.ceil(remaining);

        const numEl  = $('#sv-countdown');
        const ringEl = $('#sv-ring-fill');

        if (numEl) {
            numEl.textContent = leftInt;
            numEl.classList.toggle('urgent-num', leftInt <= 5);
        }
        if (ringEl) {
            const fraction = remaining / total;
            ringEl.style.strokeDashoffset = C * (1 - fraction);
            ringEl.classList.toggle('urgent', leftInt <= 5);
        }

        // Tick sound khi sang giây mới
        if (leftInt < lastSecond) {
            lastSecond = leftInt;
            if (leftInt > 0 && leftInt <= 3) Sound.play('urgent');
            else if (leftInt > 0 && leftInt <= 10) Sound.play('tick');
        }

        if (remaining > 0) {
            appState.countdownTimer = requestAnimationFrame(frame);
        } else {
            stopCountdown();
        }
    };

    appState.countdownTimer = requestAnimationFrame(frame);
}

function stopCountdown() {
    if (appState.countdownTimer) {
        cancelAnimationFrame(appState.countdownTimer);
        appState.countdownTimer = null;
    }
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

    const myAns     = appState.myAnswer;
    const isCorrect = myAns === q.correctAnswer;
    const noAns     = !myAns;

    // Banner kết quả của BẢN THÂN — rõ ràng + animation
    const banner = $('#sv-result-banner');
    if (banner) {
        if (noAns)          { banner.textContent = '⏰ Hết giờ!'; banner.className = 'sv-result-banner timeout'; }
        else if (isCorrect) { banner.textContent = '✅ CHÍNH XÁC!'; banner.className = 'sv-result-banner correct'; }
        else                { banner.textContent = `❌ Sai! Đúng là ${q.correctAnswer}`; banner.className = 'sv-result-banner wrong'; }
    }

    if (isCorrect)   Sound.play('correct');
    else if (!noAns) Sound.play('wrong');

    // 4 đáp án: chỉ hiện đáp án đúng, đáp án mình chọn, % chọn — KHÔNG hiện tên ai
    const allAns = session.answers?.filter(a => a.questionId === q.id && a.answer) || [];
    const total  = session.students?.length || 1;
    const resEl  = $('#sv-result-answers');
    if (resEl) {
        resEl.innerHTML = ['A','B','C','D'].map((letter, li) => {
            const ans        = q.answers?.find(a => a.id === letter) || { text: '' };
            const isCorrectAns = letter === q.correctAnswer;
            const isMyPick   = letter === myAns;
            const cnt        = allAns.filter(a => a.answer === letter).length;
            const pct        = Math.round(cnt / total * 100);
            let cls = 'other';
            if (isCorrectAns && isMyPick)  cls = 'correct-ans';
            else if (isCorrectAns)         cls = 'correct-ans';
            else if (isMyPick)             cls = 'my-ans-wrong';

            return `<div class="sv-res-ans-item ${cls}" style="animation:slideIn .3s ease both;animation-delay:${li*.07}s">
                <span class="sv-res-badge ${letter}">${letter}</span>
                <div style="flex:1">
                    <div>${esc(ans.text)}</div>
                    <div class="sv-res-bar-wrap">
                        <div class="sv-res-bar" style="width:${pct}%;background:${isCorrectAns?'#22a06b':isMyPick?'#e84040':'rgba(255,255,255,.2)'}"></div>
                        <span class="sv-res-pct">${pct}%</span>
                    </div>
                </div>
                <div style="margin-left:.5rem;font-size:1.1rem">
                    ${isCorrectAns ? '✅' : ''}
                    ${isMyPick && !isCorrectAns ? '👆' : ''}
                    ${isMyPick && isCorrectAns ? '👆' : ''}
                </div>
            </div>`;
        }).join('');
    }

    // Cộng điểm (chống cộng 2 lần)
    if (isCorrect && appState.currentQId !== q.id + '_scored') {
        appState.currentQId = q.id + '_scored';
        const cfg = session.gameSettings || {};
        if (cfg.scoringMode === 'by_time') {
            const totalMs  = (cfg.timePerQuestion || 15) * 1000;
            const ans      = session.answers?.find(a => a.questionId === q.id && a.studentId === appState.myStudentId);
            const elapsed  = ans?.questionStartedAt ? (ans.submittedAt - ans.questionStartedAt) : totalMs / 2;
            const frac     = Math.max(0, Math.min(1, 1 - elapsed / totalMs));
            appState.myTotalScore += Math.round((cfg.basePoints||500) + ((cfg.maxPoints||1000) - (cfg.basePoints||500)) * frac);
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

/* ===== ENDED — hiện xếp hạng bản thân ===== */
function showEnded(session) {
    showView('ended');
    Sound.play('bell');
    $('#end-student-name').textContent = appState.myStudentName || '—';

    const qTotal = session?.questions?.length || 0;
    const isTime = session?.gameSettings?.scoringMode === 'by_time';
    $('#end-score-val').textContent = isTime ? appState.myTotalScore : `${appState.myCorrect}/${qTotal}`;
    $('#end-correct-info').textContent = `✅ Đúng: ${appState.myCorrect}  ❌ Sai: ${qTotal - appState.myCorrect}`;

    // Tính xếp hạng bản thân dựa trên results từ session
    const results = session?.results;
    if (results && appState.myStudentId) {
        const myRank = results.find(r => r.studentId === appState.myStudentId);
        const rankEl = $('#end-rank-info');
        if (rankEl && myRank) {
            const medals = ['🥇','🥈','🥉'];
            const icon = myRank.rank <= 3 ? medals[myRank.rank-1] : `#${myRank.rank}`;
            rankEl.innerHTML = `<div class="end-rank-badge">${icon} Xếp hạng ${myRank.rank} / ${results.length}</div>`;
        }
    }
}

/* ===== HELPERS ===== */
function setStatus(viewId, msg, type) {
    const map = { 'enter-code': '#enter-code-status', 'pick-name': '#pick-name-status' };
    const el  = $(map[viewId]);
    if (!el) return;
    el.textContent = msg;
    el.className   = 'sv-status' + (type ? ' ' + type : '');
}
