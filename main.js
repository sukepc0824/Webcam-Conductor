let BEATMAP = [
    0.3023, 0.7359, 1.3566, 1.9085, 2.5095, 3.0849, 3.6579, 4.2640, 4.8437, 5.3744,
    5.9608, 6.5320, 7.0607, 7.6168, 8.2044, 8.7943, 9.3614, 9.9413, 10.5362, 11.1101,
    11.7064, 12.2716, 12.8597, 13.4706, 14.0639, 14.6942, 15.3050, 15.9148, 16.4444, 17.0323,
    17.6045, 18.1706, 18.7587, 19.3436, 19.9440, 20.5511, 21.1701, 21.7249, 22.3264, 22.9316,
    23.5426, 24.1010, 24.6657, 25.2261, 25.7914, 26.3384, 26.9383, 27.5162, 28.1107, 28.7201,
    29.2992, 29.8725, 30.4838, 31.0330, 31.6204, 32.1841, 32.7701, 33.3652, 33.9386, 34.5540,
    35.1364, 35.7252, 36.3145, 36.8836, 37.4760, 38.0585, 38.6583, 39.2238, 39.7900, 40.4186,
    41.0068, 41.5743, 42.1498, 42.7356, 43.3029, 43.9210, 44.5046, 45.0766, 45.6756, 46.1952,
    46.8075, 47.3765, 47.9632, 48.5498, 49.1301, 49.7174, 50.3113, 50.9200, 51.5404, 52.1369,
    52.7516, 53.3173, 53.9216, 54.4926, 55.0578, 55.6210, 56.2043, 56.8166, 57.4074, 58.0176,
    58.6264, 59.2222, 59.8341, 60.4684
]

for (let i = 0; i < BEATMAP.length; i++) {
    BEATMAP[i] += 0.2;
}
const CONFIG = {
    BPM: 110, // Will be overridden by user input
    TOLERANCE_MS: 300,
    HISTORY_SIZE: 20,
    BEAT_THRESHOLD: 0.05
};
let state = {
    isPlaying: false,
    isPreparingToStart: false,
    currentBeatIndex: 0,
    nextBeatTime: 0,
    positionHistory: [],
    lastBeatTriggerTime: 0,
    beatFeedbackTime: 0,
    currentBPM: CONFIG.BPM,
    isMusicLoaded: true,
    beatTimestamps: [],
    beatTimestampIndex: 0,
    conductorIntervals: [],  // rolling window of last N conductor beat intervals (ms)
    targetRate: 1.0,         // desired playback rate (updated per beat)
    smoothedRate: 1.0,       // actual rate, lerped toward targetRate each frame
    targetVolume: 1.0,
    smoothedVolume: 1.0,
    closedStillStartTime: 0,
    smoothedBatonX: undefined,
    smoothedBatonY: undefined,
    beatMarkers: [],
    beatmapMarkerIndex: 0,
    performanceData: [],
    targetLowGain: 0,
    smoothedLowGain: 0,
    targetHighGain: 0,
    smoothedHighGain: 0,
    targetPan: 0,
    smoothedPan: 0,
    isFinished: false,
    openHandStartTime: 0
};
let audioCtx, lowShelf, highShelf, panner, sourceNode;
const RATE_SMOOTH_WINDOW = 3;
const RATE_LERP_PER_FRAME = 0;

const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const uiInstruction = document.getElementById('instruction');
const uiInstructionEn = document.getElementById('instruction-en');

const bgm = document.getElementById('bgm');
const clapSound = document.getElementById('clap-sound');
const progressBar = document.getElementById('progress-bar');
const progressContainer = document.getElementById('progress-container');



function distance(p1, p2) {
    const dx = (p1.x - p2.x) * 16 / 9;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
}
function nextBeatWallTime(idx) {
    const nextAudioSec = state.beatTimestamps[idx];
    const audioSecsLeft = nextAudioSec - bgm.currentTime;
    return performance.now() + (audioSecsLeft / bgm.playbackRate) * 1000;
}

function evaluateBeat(currentTime) {
    if (currentTime > state.nextBeatTime + CONFIG.TOLERANCE_MS) {
        advanceBeat();
        return;
    }
}

function triggerPlayerBeat(currentTime) {
    const timeSinceLastBeat = currentTime - state.lastBeatTriggerTime;
    let minInterval;
    if (state.beatTimestamps.length > 1 && state.beatTimestampIndex > 0) {
        const prevTs = state.beatTimestamps[state.beatTimestampIndex - 1];
        const nextTs = state.beatTimestamps[Math.min(state.beatTimestampIndex, state.beatTimestamps.length - 1)];
        minInterval = (nextTs - prevTs) * 400;
    } else {
        minInterval = (60 / CONFIG.BPM) * 400;
    }
    if (state.lastBeatTriggerTime > 0 && timeSinceLastBeat < minInterval) return;

    const diffFromExpected = Math.abs(currentTime - state.nextBeatTime);
    const isHit = diffFromExpected <= CONFIG.TOLERANCE_MS;
    if (state.beatTimestamps.length > 0 && !isHit) {
        state.beatFeedbackTime = currentTime;
        return;
    }

    if (state.lastBeatTriggerTime > 0) {
        const rawPhaseError = currentTime - state.nextBeatTime;
        const phaseErrorMs = Math.max(-500, Math.min(500, rawPhaseError));
        const kP = 0.0015;
        const phaseCorrection = -phaseErrorMs * kP; // Slow down if late, speed up if early

        if (state.beatTimestamps.length > 0) {
            state.conductorIntervals.push(timeSinceLastBeat);
            if (state.conductorIntervals.length > RATE_SMOOTH_WINDOW) {
                state.conductorIntervals.shift();
            }

            const avgConductorMs = state.conductorIntervals.reduce((a, b) => a + b, 0)
                / state.conductorIntervals.length;

            const idx = state.beatTimestampIndex;
            const lookback = state.conductorIntervals.length;
            const fromIdx = Math.max(1, idx - lookback + 1);
            let bmSum = 0, bmCount = 0;
            for (let i = fromIdx; i <= idx && i < state.beatTimestamps.length; i++) {
                bmSum += (state.beatTimestamps[i] - state.beatTimestamps[i - 1]) * 1000;
                bmCount++;
            }
            const avgBmMs = bmCount > 0
                ? bmSum / bmCount
                : (state.beatTimestamps.length > 1
                    ? (state.beatTimestamps[1] - state.beatTimestamps[0]) * 1000
                    : 500);
            const baseRate = avgBmMs / avgConductorMs;
            let totalRate = baseRate + phaseCorrection;
            if (totalRate > 1.3 || totalRate < 0.7) {
                totalRate = 1.0;
                state.conductorIntervals = [];
            }

            state.targetRate = Math.max(0.25, Math.min(3.0, totalRate));

            if (bgm.paused) bgm.play();
        } else {
            state.conductorIntervals.push(timeSinceLastBeat);
            if (state.conductorIntervals.length > RATE_SMOOTH_WINDOW) state.conductorIntervals.shift();

            const avgMs = state.conductorIntervals.reduce((a, b) => a + b, 0) / state.conductorIntervals.length;
            const newBPM = Math.max(30, Math.min(240, 60000 / avgMs));

            state.currentBPM = newBPM;
            const baseRate = newBPM / CONFIG.BPM;
            let totalRate = baseRate + phaseCorrection;
            if (totalRate > 1.5 || totalRate < 0.5) {
                totalRate = 1.0;
                state.conductorIntervals = [];
            }

            state.targetRate = Math.max(0.25, Math.min(3.0, totalRate));
            if (bgm.paused) bgm.play();
        }
    } else {
        if (bgm.paused) bgm.play();
    }

    state.beatFeedbackTime = currentTime;
    state.lastBeatTriggerTime = currentTime;
    advanceBeat(currentTime);
}

function advanceBeat(currentTime) {
    state.currentBeatIndex = (state.currentBeatIndex + 1) % 4;

    if (state.beatTimestamps.length > 0) {
        state.beatTimestampIndex++;
        if (state.beatTimestampIndex < state.beatTimestamps.length) {
            state.nextBeatTime = nextBeatWallTime(state.beatTimestampIndex);
        } else {
            const last = state.beatTimestamps[state.beatTimestamps.length - 1];
            const prev = state.beatTimestamps[state.beatTimestamps.length - 2];
            const avgIntervalMs = ((last - prev) / bgm.playbackRate) * 1000;
            state.nextBeatTime = (state.nextBeatTime || currentTime) + avgIntervalMs;
        }
    } else {
        const beatInterval = 0;
        if (currentTime) {
            state.nextBeatTime = currentTime + beatInterval;
        } else {
            state.nextBeatTime += beatInterval;
        }
    }
}
function isOpenHand(landmarks) {
    if (!landmarks) return false;
    const wrist = landmarks[0];
    const thumbDistTip = distance(wrist, landmarks[4]);
    const thumbDistMcp = distance(wrist, landmarks[2]);
    const idxDistTip = distance(wrist, landmarks[8]);
    const idxDistMcp = distance(wrist, landmarks[5]);
    const midDistTip = distance(wrist, landmarks[12]);
    const midDistMcp = distance(wrist, landmarks[9]);
    const ringDistTip = distance(wrist, landmarks[16]);
    const ringDistMcp = distance(wrist, landmarks[13]);
    const pinkyDistTip = distance(wrist, landmarks[20]);
    const pinkyDistMcp = distance(wrist, landmarks[17]);
    const THRESHOLD = 1.7;

    return (
        thumbDistTip > thumbDistMcp * 1.3 && // Thumb is shorter, different ratio
        idxDistTip > idxDistMcp * THRESHOLD &&
        midDistTip > midDistMcp * THRESHOLD &&
        ringDistTip > ringDistMcp * THRESHOLD &&
        pinkyDistTip > pinkyDistMcp * THRESHOLD
    );
}

function onResults(results) {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    const w = canvasElement.width;
    const h = canvasElement.height;
    const currentTime = performance.now();

    canvasCtx.beginPath();
    canvasCtx.arc(w / 2, h - 100, 50, 0, 2 * Math.PI);

    if (state.isPlaying) {
        const lastData = state.performanceData[state.performanceData.length - 1];
        if (!lastData || (bgm.currentTime - lastData.time) >= 0.2) {
            state.performanceData.push({
                time: bgm.currentTime,
                rate: state.smoothedRate,
                volume: state.smoothedVolume
            });
        }
        if (Math.abs(state.smoothedRate - state.targetRate) > 0.001) {
            const diff = state.targetRate - state.smoothedRate;
            let step = diff * 0.1; // 10% closing per frame
            const maxStep = RATE_LERP_PER_FRAME; // 0.05

            if (Math.abs(step) > maxStep) step = Math.sign(diff) * maxStep;

            state.smoothedRate += step;

            if (Math.abs(state.targetRate - state.smoothedRate) < 0.005) {
                state.smoothedRate = state.targetRate;
            }

            if (bgm.playbackRate !== state.smoothedRate) {
                bgm.playbackRate = state.smoothedRate;
            }
            state.currentBPM = CONFIG.BPM * state.smoothedRate;
        }
        if (Math.abs(state.smoothedVolume - state.targetVolume) > 0.01) {
            const diff = state.targetVolume - state.smoothedVolume;
            const lerpFactor = diff < 0 ? 0.15 : 0.1;
            const maxStep = diff < 0 ? 0.08 : 0.05;
            const step = Math.sign(diff) * Math.min(Math.abs(diff) * lerpFactor, maxStep);
            state.smoothedVolume += step;
            if (Math.abs(state.targetVolume - state.smoothedVolume) < 0.01) {
                state.smoothedVolume = state.targetVolume;
            }
            if (bgm.volume !== state.smoothedVolume) {
                bgm.volume = state.smoothedVolume;
            }
        }
        if (lowShelf && highShelf) {
            state.smoothedLowGain += (state.targetLowGain - state.smoothedLowGain) * 0.8;
            state.smoothedHighGain += (state.targetHighGain - state.smoothedHighGain) * 0.8;

            lowShelf.gain.value = state.smoothedLowGain;
            highShelf.gain.value = state.smoothedHighGain;
            const lowBoostLabel = document.getElementById('ui-low-boost');
            const highBoostLabel = document.getElementById('ui-high-boost');
            if (lowBoostLabel && highBoostLabel) {
                if (state.smoothedLowGain > 2) lowBoostLabel.classList.add('highlight');
                else lowBoostLabel.classList.remove('highlight');

                if (state.smoothedHighGain > 2) highBoostLabel.classList.add('highlight');
                else highBoostLabel.classList.remove('highlight');
            }
        }
        if (panner) {
            state.smoothedPan += (state.targetPan - state.smoothedPan) * 0.1;
            panner.pan.value = state.smoothedPan;
        }
        if (state.beatTimestamps.length > 0
            && state.beatTimestampIndex < state.beatTimestamps.length
            && !bgm.paused) {
            state.nextBeatTime = nextBeatWallTime(state.beatTimestampIndex);
        }
        if (state.beatTimestamps.length === 0 && state.lastBeatTriggerTime > 0) {
            const timeSinceLastBeat = currentTime - state.lastBeatTriggerTime;
            const expectedInterval = 60000 / state.currentBPM;

            if (timeSinceLastBeat > expectedInterval * 1.5) {
                state.targetRate = Math.max(0.05, state.targetRate * 0.99);
                if (state.smoothedRate <= 0.15 && !bgm.paused) {
                    bgm.pause();

                }
            }
        }

        const timeDiff = Math.max(0, state.nextBeatTime - currentTime);
        let refInterval;
        if (state.beatTimestamps.length > 1 && state.beatTimestampIndex > 0 && state.beatTimestampIndex < state.beatTimestamps.length) {
            const prevSec = state.beatTimestamps[state.beatTimestampIndex - 1];
            const nextSec = state.beatTimestamps[state.beatTimestampIndex];
            refInterval = (nextSec - prevSec) * 1000;
        } else {
            refInterval = (60 / Math.max(1, state.currentBPM)) * 1000;
        }
        const pulse = 1 - Math.min(1, timeDiff / refInterval);
        while (state.beatmapMarkerIndex < BEATMAP.length && bgm.currentTime >= BEATMAP[state.beatmapMarkerIndex]) {
            if (state.smoothedBatonX !== undefined && state.smoothedBatonY !== undefined) {
                state.beatMarkers.push({
                    canvasX: state.smoothedBatonX,
                    canvasY: state.smoothedBatonY,
                    time: currentTime,
                    beatNumber: (state.beatmapMarkerIndex % 4) + 1
                });
            }
            state.beatmapMarkerIndex++;
        }
        if (bgm.duration) {
            const progress = (bgm.currentTime / bgm.duration) * 100;
            progressBar.style.width = `${progress}%`;
        }
    }
    const TRAIL_LIFETIME = 2000; // ms
    state.positionHistory = state.positionHistory.filter(p => currentTime - p.time < TRAIL_LIFETIME);
    state.beatMarkers = state.beatMarkers.filter(m => currentTime - m.time < TRAIL_LIFETIME);
    if (state.positionHistory.length > 1 && state.isPlaying) {
        canvasCtx.lineCap = 'round';
        canvasCtx.lineJoin = 'round';

        for (let i = 1; i < state.positionHistory.length; i++) {
            const age = currentTime - state.positionHistory[i].time;
            const ratio = Math.max(0, 1 - (age / TRAIL_LIFETIME));
            const opacity = ratio * ratio;

            canvasCtx.beginPath();
            canvasCtx.moveTo(state.positionHistory[i - 1].canvasX, state.positionHistory[i - 1].canvasY);
            canvasCtx.lineTo(state.positionHistory[i].canvasX, state.positionHistory[i].canvasY);
            canvasCtx.strokeStyle = `rgba(${opacity * 255}, ${opacity * 255}, ${opacity * 255})`;
            canvasCtx.lineWidth = 6;
            canvasCtx.stroke();
        }
    }
    for (const marker of state.beatMarkers) {
        const age = currentTime - marker.time;
        const ratio = Math.max(0, 1 - (age / TRAIL_LIFETIME));
        const opacity = ratio;

        canvasCtx.save();
        canvasCtx.translate(marker.canvasX - 24, marker.canvasY - 34);
        canvasCtx.scale(-1, 1);
        canvasCtx.font = '30px Zen Kaku Gothic New';
        canvasCtx.textAlign = 'center';
        canvasCtx.textBaseline = 'middle';
        canvasCtx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
        canvasCtx.fillText(marker.beatNumber.toString(), 0, 0);
        canvasCtx.restore();
    }

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        let targetHand = results.multiHandLandmarks[0];
        if (!state.isPlaying && !state.isPreparingToStart && state.isMusicLoaded && !state.isFinished) {
            if (isOpenHand(targetHand)) {
                if (state.openHandStartTime === 0) {
                    state.openHandStartTime = currentTime;
                } else if (currentTime - state.openHandStartTime > 110) {
                    startConduct();
                    state.openHandStartTime = 0;
                }
            } else {
                state.openHandStartTime = 0;
            }
        }
        drawConnectors(canvasCtx, targetHand, HAND_CONNECTIONS,
            { color: 'rgba(255, 255, 255, 0.2)', lineWidth: 5 });
        const indexTip = targetHand[8];
        const rawX = indexTip.x * canvasElement.width;
        const rawY = indexTip.y * canvasElement.height;
        const smoothingFactor = 0.4; // 0〜1の値 (0に近いほど滑らか、1に近いほど素早く追従)
        if (state.smoothedBatonX === undefined || state.smoothedBatonY === undefined) {
            state.smoothedBatonX = rawX;
            state.smoothedBatonY = rawY;
        } else {
            state.smoothedBatonX += (rawX - state.smoothedBatonX) * smoothingFactor;
            state.smoothedBatonY += (rawY - state.smoothedBatonY) * smoothingFactor;
        }

        const batonX = state.smoothedBatonX;
        const batonY = state.smoothedBatonY;
        const smoothedNormalizedX = batonX / canvasElement.width;
        const smoothedNormalizedY = batonY / canvasElement.height;
        state.positionHistory.push({ x: smoothedNormalizedX, y: smoothedNormalizedY, time: currentTime, canvasX: batonX, canvasY: batonY });
        const AMPLITUDE_WINDOW = 600;
        const recentPoints = state.positionHistory.filter(p => currentTime - p.time < AMPLITUDE_WINDOW);
        if (recentPoints.length > 1) {
            let minX = recentPoints[0].x, maxX = recentPoints[0].x;
            let minY = recentPoints[0].y, maxY = recentPoints[0].y;

            for (let i = 1; i < recentPoints.length; i++) {
                minX = Math.min(minX, recentPoints[i].x);
                maxX = Math.max(maxX, recentPoints[i].x);
                minY = Math.min(minY, recentPoints[i].y);
                maxY = Math.max(maxY, recentPoints[i].y);
            }
            const dx = (maxX - minX) * 16 / 9; // aspect ratio correct
            const dy = maxY - minY;
            const amplitude = Math.sqrt(dx * dx + dy * dy);
            let vol = (amplitude - 0.05) / 0.4;
            vol = Math.pow(Math.max(0, vol), 2); // 変化をよりダイナミックにするために二乗を適用
            vol = Math.max(0.1, Math.min(1, vol)); // clamp 0.1 ~ 1.0
            state.targetVolume = vol;
            const panRatio = Math.max(0, Math.min(1, batonX / canvasElement.width));
            const filterIntensity = 12.0;
            state.targetLowGain = Math.max(0, (0.3 - panRatio) * 2 * filterIntensity);
            state.targetHighGain = Math.max(0, (panRatio - 0.7) * 2 * filterIntensity);
            state.targetPan = (0.5 - panRatio) * 1.5;

            if (state.isPlaying && !isOpenHand(targetHand) && amplitude < 0.05) {
                if (state.closedStillStartTime === 0) {
                    state.closedStillStartTime = currentTime;
                } else if (currentTime - state.closedStillStartTime > 500) { // 0.6 seconds
                    state.isPlaying = false;

                    const steps = 8;
                    const stepTime = 15;
                    const volStep = bgm.volume / steps;
                    let currentStep = 0;

                    const fadeInterval = setInterval(() => {
                        currentStep++;
                        bgm.volume = Math.max(0, bgm.volume - volStep);

                        if (currentStep >= steps) {
                            clearInterval(fadeInterval);
                            bgm.pause();
                            bgm.volume = state.smoothedVolume;

                            uiInstruction.style.display = 'block';
                            uiInstruction.textContent = '演奏を停止しました。手を開いて再開します。';
                            uiInstructionEn.textContent = 'Stopped the performance. Open your hand to resume.';
                        }
                    }, stepTime);

                    state.closedStillStartTime = 0;
                }
            } else {
                state.closedStillStartTime = 0;
            }
        }
        if (state.isPlaying && state.positionHistory.length >= 4) {
            const pts = state.positionHistory.slice(-4);
            const vels = [];
            for (let i = 1; i < pts.length; i++) {
                const dt = Math.max(1, pts[i].time - pts[i - 1].time) / 1000.0; // seconds
                const dx = (pts[i].x - pts[i - 1].x) * 16 / 9;
                const dy = pts[i].y - pts[i - 1].y;
                vels.push({ vx: dx / dt, vy: dy / dt, time: pts[i].time });
            }
            const accels = [];
            for (let i = 1; i < vels.length; i++) {
                const dt = Math.max(1, vels[i].time - vels[i - 1].time) / 1000.0;
                const ax = (vels[i].vx - vels[i - 1].vx) / dt;
                const ay = (vels[i].vy - vels[i - 1].vy) / dt;
                const magnitude = Math.sqrt(ax * ax + ay * ay);
                accels.push(magnitude);
            }
            if (state.lastAccel === undefined) state.lastAccel = 0;
            if (state.currentAccel === undefined) state.currentAccel = 0;
            const accelSmoothing = 0.4;
            const newAccel = accels[accels.length - 1];

            state.lastAccel = state.currentAccel;
            state.currentAccel = (newAccel * accelSmoothing) + (state.currentAccel * (1 - accelSmoothing));
            const ACCEL_THRESHOLD = 30.0; // Needs tuning based on average webcam framerate and units
            if (state.lastAccel > ACCEL_THRESHOLD &&
                state.lastAccel > state.currentAccel &&
                state.lastAccel > (state.prevAccel || 0)) {

                triggerPlayerBeat(currentTime);
            }
            state.prevAccel = state.lastAccel;
        }

        canvasCtx.beginPath();
        canvasCtx.arc(batonX, batonY, 9, 0, 2 * Math.PI);
        canvasCtx.fillStyle = '#fff';
        canvasCtx.shadowColor = '#fff';
        canvasCtx.fill();
        canvasCtx.shadowBlur = 0; // reset
    }

    if (state.isPlaying) {
        evaluateBeat(currentTime);
        document.querySelector('.instruction-bottom').classList.add('active');
    } else {
        document.querySelector('.instruction-bottom').classList.remove('active');
    }

    canvasCtx.restore();
}

const hands = new Hands({
    locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }
});
hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.1,
    minTrackingConfidence: 0.3
});
hands.onResults(onResults);

const camera = new Camera(videoElement, {
    onFrame: async () => {
        await hands.send({ image: videoElement });
    },
    width: 480,
    height: 360,
    fps: 30
});
function startConduct() {
    if (!state.isPlaying && !state.isPreparingToStart) {
        if (!state.isMusicLoaded) {
            alert('先に音楽ファイル(MP3など)を選択してください！');
            return;
        }
        state.isPreparingToStart = true;

        const beatInterval = (60 / CONFIG.BPM) * 1000;
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            sourceNode = audioCtx.createMediaElementSource(bgm);

            lowShelf = audioCtx.createBiquadFilter();
            lowShelf.type = 'lowshelf';
            lowShelf.frequency.value = 100; // Low frequency cutoff

            highShelf = audioCtx.createBiquadFilter();
            highShelf.type = 'highshelf';
            highShelf.frequency.value = 1200; // High frequency cutoff

            panner = audioCtx.createStereoPanner();
            sourceNode.connect(lowShelf);
            lowShelf.connect(highShelf);
            highShelf.connect(panner);
            panner.connect(audioCtx.destination);
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        setTimeout(() => {
            state.isPreparingToStart = false;
            state.isPlaying = true;
            uiInstruction.textContent = '指揮で演奏に強弱をつけてみましょう。手を閉じて演奏を中断します。';
            uiInstructionEn.textContent = 'Let\'s try to play with dynamics. Open your hand to stop the performance.';

            state.currentBeatIndex = 0;
            state.positionHistory = [];
            state.currentBPM = CONFIG.BPM;
            state.lastBeatTriggerTime = 0;
            state.beatTimestampIndex = 0;
            state.conductorIntervals = [];
            state.targetRate = 1.0;
            state.smoothedRate = 1.0;
            state.targetVolume = 1.0;
            state.smoothedVolume = 1.0;
            state.closedStillStartTime = 0;
            state.smoothedBatonX = undefined;
            state.smoothedBatonY = undefined;
            state.beatMarkers = [];
            state.performanceData = [];
            state.beatmapMarkerIndex = 0;
            for (let i = 0; i < BEATMAP.length; i++) {
                if (BEATMAP[i] <= bgm.currentTime) {
                    state.beatmapMarkerIndex = i + 1;
                } else {
                    break;
                }
            }

            bgm.playbackRate = 1.0;
            bgm.volume = 1.0;
            bgm.play();
            progressContainer.style.display = 'block';

            if (state.beatTimestamps.length > 0) {
                state.nextBeatTime = nextBeatWallTime(0);
            } else {
                state.nextBeatTime = performance.now() + beatInterval;
            }
        }, beatInterval);

    } else if (state.isPlaying || state.isPreparingToStart) {
        state.isPreparingToStart = false;
        uiInstruction.style.display = 'block';
        uiInstruction.textContent = '手をカメラにかざしてください';
        state.isPlaying = false;
        bgm.pause();
        bgm.currentTime = 0;

    }
};

let resultChartInstance = null;
function showResults() {
    document.getElementById('result-text').classList.add('active');

    if (resultChartInstance) {
        resultChartInstance.destroy();
    }

    const ctx = document.getElementById('resultChart').getContext('2d');
    const times = state.performanceData.map(d => Math.round(d.time * 10) / 10);
    const rates = state.performanceData.map(d => Math.round(d.rate * 100));
    const volumes = state.performanceData.map(d => Math.round(d.volume * 100));

    resultChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: times,
            datasets: [
                {
                    label: 'テンポ (Tempo %)',
                    data: rates,
                    borderColor: 'rgba(88, 166, 255, 1)',
                    backgroundColor: 'rgba(88, 166, 255, 0.2)',
                    yAxisID: 'y',
                    tension: 0.4
                },
                {
                    label: '強弱 (Volume %)',
                    data: volumes,
                    borderColor: 'rgba(255, 123, 114, 1)',
                    backgroundColor: 'rgba(255, 123, 114, 0.2)',
                    yAxisID: 'y1',
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: '時間 (秒)',
                        color: '#c9d1d9'
                    },
                    ticks: { color: '#c9d1d9' }
                },
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: 'テンポ (%)',
                        color: '#c9d1d9'
                    },
                    ticks: { color: '#c9d1d9' }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: {
                        display: true,
                        text: '強弱 (%)',
                        color: '#c9d1d9'
                    },
                    ticks: { color: '#c9d1d9' },
                    grid: {
                        drawOnChartArea: false
                    }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#c9d1d9' }
                }
            }
        }
    });
}

bgm.addEventListener('ended', () => {
    state.isPlaying = false;
    state.isFinished = true;
    clapSound.play();
    uiInstruction.style.display = 'block';
    uiInstruction.textContent = '演奏終了。おつかれさまでした。';
    uiInstructionEn.textContent = 'Performance ended.';

    showResults();
    progressContainer.style.display = 'none';
});
camera.start().then(() => {
    uiInstruction.textContent = '曲を始めましょう。手を勢いよく開いてください。';
    uiInstructionEn.textContent = 'Let\'s start the music. Open your hand with force.';
}).catch(err => {
    uiInstruction.textContent = 'カメラのアクセスが拒否されました。';
    uiInstructionEn.textContent = 'Camera access denied.';
    console.error(err);
});

const isChrome = /Chrome/.test(navigator.userAgent);
if (!isChrome) {
    alert('このWebアプリはGoogle Chromeでのみ、最適に動作します。This web app is only compatible with Google Chrome.');
}