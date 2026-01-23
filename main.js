import {
    FilesetResolver,
    HandLandmarker,
    DrawingUtils
} from '@mediapipe/tasks-vision';

let handLandmarker = undefined;
let runningMode = 'VIDEO';
let webcamRunning = false;

// --- STATE ---
const handStates = {
    "Left": { isPinching: false, previousPoint: null, pinchStartTime: 0 },
    "Right": { isPinching: false, previousPoint: null, pinchStartTime: 0 }
};

// Dwell State
let currentHovered = null;
const DWELL_TIME = 800; // ms

// Confirm State
let clearConfirmTimer = null;
let isClearPending = false;

const cursorElements = {
    "Left": document.getElementById('hand-cursor-left'),
    "Right": document.getElementById('hand-cursor-right')
};

let currentTool = 'brush';
let brushColor = '#FF0000';
let brushSize = 12;
let currentStyle = 'normal';
let showSkeleton = true;

const undoStack = [];
const MAX_UNDO = 10;
const PINCH_START_THRESHOLD = 0.03;
const PINCH_STOP_THRESHOLD = 0.05;

let uiElements = [];
let lastClickTime = 0;
const CLICK_COOLDOWN = 1000;

const video = document.getElementById('webcam');
const inkCanvas = document.getElementById('ink_canvas');
const debugCanvas = document.getElementById('debug_canvas');
const inkCtx = inkCanvas.getContext('2d');
const debugCtx = debugCanvas.getContext('2d');

// Optimization: Low Res AI Canvas
const aiCanvas = document.createElement('canvas'); // Offscreen
const aiCtx = aiCanvas.getContext('2d', { alpha: false }); // Optimize for speed

const enableWebcamButton = document.getElementById('enableWebcamButton');
const toastContainer = document.getElementById('toast-container');

// Selectors
const undoBtn = document.getElementById('undoBtn');
const snapshotBtn = document.getElementById('snapshotBtn');
const clearBtn = document.getElementById('clearBtn');
const toggleDebugBtn = document.getElementById('toggleDebugBtn');

function updateUIHitTargets() {
    const targets = document.querySelectorAll('.hover-target');
    uiElements = Array.from(targets).map(el => ({
        rect: el.getBoundingClientRect(),
        element: el
    }));
}
window.addEventListener('resize', () => {
    resizeCanvases();
    setTimeout(updateUIHitTargets, 500);
});
setTimeout(updateUIHitTargets, 1000);

function showToast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerText = msg;
    toastContainer.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    }, 2000);
}

function setupClickListeners() {
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentTool = e.currentTarget.dataset.tool;
            showToast(`Tool: ${currentTool}`);
        });
    });

    document.querySelectorAll('.style-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentStyle = e.currentTarget.dataset.style;
            showToast(`Style: ${currentStyle}`);
        });
    });

    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            brushColor = e.currentTarget.dataset.color;
            if (currentTool === 'eraser') document.querySelector('[data-tool="brush"]').click();
        });
    });

    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            brushSize = parseInt(e.currentTarget.dataset.size);
        });
    });

    // SAFETY CLEAR
    clearBtn.addEventListener('click', () => {
        if (!isClearPending) {
            // First Click
            isClearPending = true;
            clearBtn.style.color = 'red'; // Visual Warning
            clearBtn.style.borderColor = 'red';
            showToast("⚠️ Click again to Confirm");

            clearConfirmTimer = setTimeout(() => {
                isClearPending = false;
                clearBtn.style.color = '';
                clearBtn.style.borderColor = '';
            }, 3000); // 3s window
        } else {
            // Confirm Click
            clearTimeout(clearConfirmTimer);
            isClearPending = false;
            clearBtn.style.color = '';
            clearBtn.style.borderColor = '';

            saveStateToUndo();
            inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
            showToast("Cleared!");
        }
    });

    undoBtn.addEventListener('click', doUndo);
    snapshotBtn.addEventListener('click', takeSnapshot);

    toggleDebugBtn.addEventListener('click', () => {
        showSkeleton = !showSkeleton;
        toggleDebugBtn.innerText = showSkeleton ? "HIDE SKELETON" : "SHOW SKELETON";
    });
}
setupClickListeners();

function saveStateToUndo() {
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    inkCtx.globalCompositeOperation = 'source-over';
    undoStack.push(inkCtx.getImageData(0, 0, inkCanvas.width, inkCanvas.height));
}

function doUndo() {
    if (undoStack.length > 0) {
        const lastState = undoStack.pop();
        inkCtx.putImageData(lastState, 0, 0);
        showToast("Undo");
    }
}

function takeSnapshot() {
    showToast("Snapshot...");
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = inkCanvas.width;
    tempCanvas.height = inkCanvas.height;
    const ctx = tempCanvas.getContext('2d');

    ctx.save();
    ctx.translate(tempCanvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    ctx.drawImage(inkCanvas, 0, 0, tempCanvas.width, tempCanvas.height);
    ctx.restore();

    const link = document.createElement('a');
    const now = new Date();
    const dateStr = `${now.getDate()}-${now.getMonth() + 1}-${now.getFullYear()}`;
    link.download = `Pintacara-${dateStr}.png`;
    link.href = tempCanvas.toDataURL('image/png');
    link.click();
}


const hasGetUserMedia = () => !!navigator.mediaDevices?.getUserMedia;
if (hasGetUserMedia()) {
    enableWebcamButton.addEventListener('click', enableCam);
}

const createHandLandmarker = async () => {
    try {
        const visionGen = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
        );
        handLandmarker = await HandLandmarker.createFromOptions(visionGen, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                delegate: 'GPU'
            },
            runningMode: runningMode,
            numHands: 2,
            // PERFORMANCE OPTIMIZATION 1: Confidence Tuning
            minHandDetectionConfidence: 0.3,
            minHandPresenceConfidence: 0.3,
            minTrackingConfidence: 0.3
        });
        enableWebcamButton.textContent = "START CAMERA";
    } catch (e) {
        console.error(e);
        alert("Failed to load MediaPipe.");
    }
};
createHandLandmarker();

const drawingUtils = new DrawingUtils(debugCtx);

function enableCam(event) {
    if (!handLandmarker) return;
    webcamRunning = true;
    enableWebcamButton.style.display = 'none';

    const constraints = {
        video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user"
        }
    };

    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        video.srcObject = stream;
        video.addEventListener('loadeddata', predictWebcam);
        resizeCanvases();
        updateUIHitTargets();
    });
}

function resizeCanvases() {
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const aspect = winW / winH;
    const targetHeight = 720;
    const targetWidth = Math.round(targetHeight * aspect);

    if (inkCanvas.height !== targetHeight) {
        inkCanvas.width = targetWidth;
        inkCanvas.height = targetHeight;
        debugCanvas.width = targetWidth;
        debugCanvas.height = targetHeight;

        // AI Canvas matches Aspect but Lower Resolution
        // targetHeight 720 -> 360 AI
        aiCanvas.height = 360;
        aiCanvas.width = Math.round(360 * aspect);
    }
}
window.addEventListener('resize', resizeCanvases);


let lastVideoTime = -1;
let results = undefined;
let rainbowHue = 0;

async function predictWebcam() {
    if (!webcamRunning) return;

    if (runningMode === 'IMAGE') {
        runningMode = 'VIDEO';
        await handLandmarker.setOptions({ runningMode: 'VIDEO' });
    }

    if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;

        // PERFORMANCE OPTIMIZATION 3: Low-Res Processing
        // Draw video frame to small offscreen canvas
        aiCtx.drawImage(video, 0, 0, aiCanvas.width, aiCanvas.height);
        // Pass small canvas to MediaPipe
        results = handLandmarker.detectForVideo(aiCanvas, performance.now());
    }

    debugCtx.save();
    debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);

    rainbowHue = (rainbowHue + 3) % 360;

    const videoRatio = video.videoWidth / video.videoHeight;
    const screenRatio = inkCanvas.width / inkCanvas.height;

    const videoRenderWidth = (screenRatio > videoRatio) ? inkCanvas.width : (inkCanvas.height * videoRatio);
    const videoRenderHeight = (screenRatio > videoRatio) ? (inkCanvas.width / videoRatio) : inkCanvas.height;
    const correctionX = (screenRatio > videoRatio) ? 0 : (inkCanvas.width - videoRenderWidth) / 2;
    const correctionY = (screenRatio > videoRatio) ? (inkCanvas.height - videoRenderHeight) / 2 : 0;

    const detectedLabels = new Set();

    // UI Check
    const checkUI = (xScreen, yScreen, isPinchStart, handLabel) => {
        const visualX = inkCanvas.width - xScreen;
        const visualY = yScreen;
        const clientX = (visualX / inkCanvas.width) * window.innerWidth;
        const clientY = (visualY / inkCanvas.height) * window.innerHeight;

        const cursor = cursorElements[handLabel];
        if (cursor) {
            cursor.classList.add('active');
            cursor.style.left = `${clientX}px`;
            cursor.style.top = `${clientY}px`;
        }

        let hovered = null;
        for (const item of uiElements) {
            const r = item.rect;
            if (clientX >= r.left && clientX <= r.right &&
                clientY >= r.top && clientY <= r.bottom) {
                hovered = item.element;
                break;
            }
        }

        // DWELL LOGIC
        if (hovered) {
            // 1. PINCH CLICK
            if (isPinchStart) {
                const now = Date.now();
                if (now - lastClickTime > CLICK_COOLDOWN) {
                    lastClickTime = now;
                    hovered.click();
                    showToast("Click!");
                    hovered.style.transform = "scale(0.9)";
                    setTimeout(() => hovered.style.transform = "", 200);
                    currentHovered = null;
                    return true;
                }
            }
            // 2. DWELL
            if (currentHovered && currentHovered.element === hovered) {
                const elapsed = Date.now() - currentHovered.startTime;
                if (elapsed > DWELL_TIME) {
                    hovered.click();
                    showToast("Click!");
                    hovered.classList.remove('dwelling');
                    currentHovered = null;
                    lastClickTime = Date.now();
                    return true;
                }
            } else {
                if (currentHovered) currentHovered.element.classList.remove('dwelling');
                currentHovered = { element: hovered, startTime: Date.now(), handLabel };
                hovered.classList.add('dwelling');
            }
        } else {
            if (currentHovered && currentHovered.handLabel === handLabel) {
                currentHovered.element.classList.remove('dwelling');
                currentHovered = null;
            }
        }
        return false;
    };


    if (results.landmarks) {
        for (let i = 0; i < results.landmarks.length; i++) {
            const landmarks = results.landmarks[i];
            const handedness = results.handednesses[i][0];
            const label = handedness.categoryName;
            detectedLabels.add(label);

            debugCtx.save();
            debugCtx.translate(correctionX, correctionY);
            debugCtx.scale(videoRenderWidth / debugCanvas.width, videoRenderHeight / debugCanvas.height);
            if (showSkeleton) {
                drawingUtils.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, { color: 'rgba(255,255,255,0.15)', lineWidth: 1 });
                drawingUtils.drawLandmarks(landmarks, { color: 'rgba(255,255,255,0.3)', radius: 2 });
            }
            debugCtx.restore();

            handleGesture(landmarks, label, videoRenderWidth, videoRenderHeight, correctionX, correctionY, checkUI);
        }
    }

    ["Left", "Right"].forEach(l => {
        if (!detectedLabels.has(l)) {
            if (cursorElements[l]) cursorElements[l].classList.remove('active');
            handStates[l].isPinching = false;
            handStates[l].previousPoint = null;
            if (currentHovered && currentHovered.handLabel === l) {
                currentHovered.element.classList.remove('dwelling');
                currentHovered = null;
            }
        }
    });

    debugCtx.restore();
    window.requestAnimationFrame(predictWebcam);
}

function handleGesture(landmarks, label, rw, rh, ox, oy, checkUIFn) {
    const thumb = landmarks[4];
    const index = landmarks[8];
    const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
    const midX = (thumb.x + index.x) / 2;
    const midY = (thumb.y + index.y) / 2;

    const curr = {
        x: midX * rw + ox,
        y: midY * rh + oy
    };

    const state = handStates[label];
    let isGrabbed = state.isPinching;

    if (isGrabbed) {
        if (dist > PINCH_STOP_THRESHOLD) isGrabbed = false;
    } else {
        if (dist < PINCH_START_THRESHOLD) isGrabbed = true;
    }

    // Check UI
    if (isGrabbed && !state.isPinching) {
        // Pinch Click
        const handled = checkUIFn(curr.x, curr.y, true, label);
        if (cursorElements[label]) cursorElements[label].classList.add('pinching');
        if (handled) return;

        saveStateToUndo();
        state.isPinching = true;
        state.previousPoint = curr;
    } else if (isGrabbed) {
        state.isPinching = true;
        checkUIFn(curr.x, curr.y, false, label);
        if (cursorElements[label]) cursorElements[label].classList.add('pinching');
    } else {
        state.isPinching = false;
        state.previousPoint = null;
        checkUIFn(curr.x, curr.y, false, label);
        if (cursorElements[label]) cursorElements[label].classList.remove('pinching');
    }

    if (state.isPinching && state.previousPoint) {
        // DRAWING
        inkCtx.beginPath();
        inkCtx.moveTo(state.previousPoint.x, state.previousPoint.y);

        inkCtx.lineCap = 'round';
        inkCtx.lineJoin = 'round';
        inkCtx.shadowBlur = 0;
        inkCtx.globalAlpha = 1.0;
        inkCtx.globalCompositeOperation = 'source-over';

        if (currentTool === 'eraser') {
            inkCtx.globalCompositeOperation = 'destination-out';
            inkCtx.lineWidth = brushSize * 1.5;
            inkCtx.strokeStyle = 'rgba(0,0,0,1)';
            inkCtx.lineTo(curr.x, curr.y);
            inkCtx.stroke();

        } else {
            if (currentStyle === 'spray') {
                const density = Math.max(1, Math.floor(brushSize / 2));
                const radius = brushSize * 1.5;
                inkCtx.fillStyle = brushColor;
                if (currentStyle === 'rainbow') inkCtx.fillStyle = `hsl(${rainbowHue}, 100%, 50%)`;

                for (let i = 0; i < density; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const r = Math.random() * radius;
                    const px = curr.x + Math.cos(angle) * r;
                    const py = curr.y + Math.sin(angle) * r;
                    inkCtx.fillRect(px, py, 1, 1);
                }
            } else if (currentStyle === 'dynamic') {
                const dx = curr.x - state.previousPoint.x;
                const dy = curr.y - state.previousPoint.y;
                const speed = Math.sqrt(dx * dx + dy * dy);
                const minW = brushSize * 0.2;
                const maxW = brushSize * 1.8;
                const t = Math.min(1, speed / 30);
                const dynWidth = maxW * (1 - t) + minW * t;

                inkCtx.lineWidth = dynWidth;
                inkCtx.strokeStyle = brushColor;
                inkCtx.lineTo(curr.x, curr.y);
                inkCtx.stroke();

            } else if (currentStyle === 'neon') {
                inkCtx.globalCompositeOperation = 'lighter';
                inkCtx.shadowBlur = 15;
                inkCtx.shadowColor = brushColor;
                inkCtx.strokeStyle = brushColor;
                inkCtx.lineWidth = brushSize;
                inkCtx.globalAlpha = 0.8;
                inkCtx.lineTo(curr.x, curr.y);
                inkCtx.stroke();

            } else if (currentStyle === 'rainbow') {
                inkCtx.strokeStyle = `hsl(${rainbowHue}, 100%, 50%)`;
                inkCtx.lineWidth = brushSize;
                inkCtx.lineTo(curr.x, curr.y);
                inkCtx.stroke();
            } else {
                inkCtx.strokeStyle = brushColor;
                inkCtx.lineWidth = brushSize;
                inkCtx.lineTo(curr.x, curr.y);
                inkCtx.stroke();
            }
        }

        state.previousPoint = curr;
    }
}
