import { useEffect, useRef, useState } from "react";
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import "./GazeTracker.css";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const EYES = [
  { corners: [33, 133], iris: [468, 469, 470, 471, 472], top: 159, bottom: 145 },
  { corners: [362, 263], iris: [473, 474, 475, 476, 477], top: 386, bottom: 374 },
];

// The board displays four selectable phrase buttons in a 2×2 grid.
// Capture four points inside EACH button so calibration reflects the actual
// selectable regions and avoids the gaps and caregiver Edit/Delete controls.
const CALIBRATION_TARGET_COUNT = 16;
const POINTS_PER_TILE = [
  { x: 0.28, y: 0.28, label: "upper left" },
  { x: 0.72, y: 0.28, label: "upper right" },
  { x: 0.28, y: 0.72, label: "lower left" },
  { x: 0.72, y: 0.72, label: "lower right" },
];
const SAMPLES_PER_TARGET = 35;

function averagePoint(points, indices) {
  const selected = indices.map((index) => points[index]).filter(Boolean);
  if (!selected.length) return null;

  return selected.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 }
  );
}

function getEyeRatios(points, eye) {
  const [cornerA, cornerB] = eye.corners.map((index) => points[index]);
  const irisSum = averagePoint(points, eye.iris);
  const upperLid = points[eye.top];
  const lowerLid = points[eye.bottom];

  if (!cornerA || !cornerB || !irisSum || !upperLid || !lowerLid) return null;

  const iris = {
    x: irisSum.x / eye.iris.length,
    y: irisSum.y / eye.iris.length,
  };

  // Horizontal gaze: iris position between the two eye corners.
  const minX = Math.min(cornerA.x, cornerB.x);
  const maxX = Math.max(cornerA.x, cornerB.x);
  const width = maxX - minX;

  // Vertical gaze: measure iris displacement from the eye-corner line.
  // Normalizing only between upper/lower eyelids can hide vertical iris
  // movement because the eyelids themselves move as the user looks around.
  // Use the corner-line midpoint as a steadier reference and eyelid distance
  // as the scale. MediaPipe image y increases downward.
  const cornerLineY = (cornerA.y + cornerB.y) / 2;
  const eyeOpening = Math.abs(lowerLid.y - upperLid.y);
  if (width <= 0 || eyeOpening <= 0.0001) return null;

  const rawVerticalOffset = (iris.y - cornerLineY) / eyeOpening;

  return {
    x: Math.max(0, Math.min(1, (iris.x - minX) / width)),
    // Keep the existing bounded value for the calibration table.
    y: Math.max(0, Math.min(1, 0.5 + rawVerticalOffset)),
    // Extra unbounded values are diagnostic only and help reveal whether
    // each eye's iris moves up/down relative to its own eye-corner line.
    rawVerticalOffset,
    irisY: iris.y,
    cornerLineY,
    eyeOpening,
  };
}

// Blink detection uses eyelid geometry only, not iris landmarks, because the
// iris landmarks can become unreliable while the eyelids are closed.
function getEyeOpennessRatio(points, eye) {
  const cornerA = points[eye.corners[0]];
  const cornerB = points[eye.corners[1]];
  const upperLid = points[eye.top];
  const lowerLid = points[eye.bottom];
  if (!cornerA || !cornerB || !upperLid || !lowerLid) return null;

  const eyeWidth = Math.hypot(cornerB.x - cornerA.x, cornerB.y - cornerA.y);
  const eyeHeight = Math.hypot(lowerLid.x - upperLid.x, lowerLid.y - upperLid.y);
  if (eyeWidth < 0.0001) return null;
  return eyeHeight / eyeWidth;
}

function detectIntentionalBlink(points, blinkState, now) {
  const openness = EYES.map((eye) => getEyeOpennessRatio(points, eye));
  if (openness.some((value) => !Number.isFinite(value))) {
    // Missing landmarks during a frame should not create a synthetic blink.
    blinkState.closedAt = null;
    return null;
  }

  openness.forEach((value, index) => {
    const baseline = blinkState.baselines[index];
    if (baseline == null) {
      // Learn each user's open-eye shape only from a clearly open eye.
      if (value > 0.09) blinkState.baselines[index] = value;
    } else if (blinkState.closedAt == null && value > baseline * 0.62) {
      // Slowly adapt to natural small changes without learning a closed eye as open.
      blinkState.baselines[index] = baseline * 0.985 + value * 0.015;
    }
  });

  const ready = blinkState.baselines.every((baseline) => Number.isFinite(baseline) && baseline > 0.09);
  if (!ready) return null;

  const bothEyesClosed = openness.every((value, index) => {
    const threshold = Math.max(0.035, blinkState.baselines[index] * 0.42);
    return value < threshold;
  });

  if (bothEyesClosed) {
    if (blinkState.closedAt == null) blinkState.closedAt = now;
    return null;
  }

  if (blinkState.closedAt == null) return null;
  const durationMs = now - blinkState.closedAt;
  blinkState.closedAt = null;

  // Reject ordinary quick blinks and unusually long closures. Requiring a reopen
  // makes the gesture a completed blink, not simply keeping the eyes closed.
  if (durationMs < 450 || durationMs > 1800 || now - blinkState.lastAcceptedAt < 1400) {
    return null;
  }

  blinkState.lastAcceptedAt = now;
  return durationMs;
}

function makeInitialBlinkState() {
  return { baselines: [null, null], closedAt: null, lastAcceptedAt: -Infinity };
}

function estimateEyePosition(points) {
  const ratios = EYES.map((eye) => getEyeRatios(points, eye)).filter(Boolean);
  if (!ratios.length) return null;

  return {
    x: ratios.reduce((sum, ratio) => sum + ratio.x, 0) / ratios.length,
    // Keep this bounded ratio for the on-screen diagnostic label.
    y: ratios.reduce((sum, ratio) => sum + ratio.y, 0) / ratios.length,
    // Use the uncompressed vertical signal for calibration/mapping.
    // The bounded ratio above can compress small but meaningful movements.
    verticalSignal:
      ratios.reduce((sum, ratio) => sum + ratio.rawVerticalOffset, 0) / ratios.length,
  };
}

function averageSamples(samples) {
  if (!samples.length) return null;
  return {
    x: samples.reduce((sum, sample) => sum + sample.x, 0) / samples.length,
    y: samples.reduce((sum, sample) => sum + sample.y, 0) / samples.length,
    verticalSignal:
      samples.reduce((sum, sample) => sum + sample.verticalSignal, 0) / samples.length,
  };
}

function classifyPosition(position) {
  if (!position) return "Iris not detected";
  const horizontal =
    position.x < 0.38 ? "image-left" : position.x > 0.62 ? "image-right" : "center";
  const vertical =
    position.y < 0.34 ? "up" : position.y > 0.68 ? "down" : "center";

  if (horizontal === "center" && vertical === "center") return "Center";
  return `${vertical === "center" ? "" : `${vertical}, `}${horizontal === "center" ? "" : horizontal}`
    .replace(/^, |, $/g, "");
}

// Solve a small linear system with partial pivoting.
function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot][column]) < 1e-9) return null;

    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let j = column; j <= size; j += 1) augmented[column][j] /= divisor;

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let j = column; j <= size; j += 1) {
        augmented[row][j] -= factor * augmented[column][j];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

// Fit both screen axes from BOTH gaze signals. A normalized 2D quadratic model
// can compensate for cross-axis coupling and mild curvature seen with webcam gaze.
function gazeFeatures(x, y) {
  return [1, x, y, x * x, x * y, y * y];
}

function fitGazeMapping(points) {
  if (!points || points.length !== CALIBRATION_TARGET_COUNT) return null;

  const meanX = points.reduce((sum, point) => sum + point.irisX, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.verticalSignal, 0) / points.length;
  const scaleX = Math.sqrt(
    points.reduce((sum, point) => sum + (point.irisX - meanX) ** 2, 0) / points.length
  );
  const scaleY = Math.sqrt(
    points.reduce((sum, point) => sum + (point.verticalSignal - meanY) ** 2, 0) / points.length
  );
  if (scaleX < 1e-5 || scaleY < 1e-5) return null;

  const rows = points.map((point) => gazeFeatures(
    (point.irisX - meanX) / scaleX,
    (point.verticalSignal - meanY) / scaleY,
  ));
  const featureCount = rows[0].length;
  const normal = Array.from({ length: featureCount }, () => Array(featureCount).fill(0));
  for (const row of rows) {
    for (let r = 0; r < featureCount; r += 1) {
      for (let c = 0; c < featureCount; c += 1) normal[r][c] += row[r] * row[c];
    }
  }

  // Mild ridge on non-constant terms reduces instability when gaze signals correlate.
  for (let index = 1; index < featureCount; index += 1) normal[index][index] += 0.01;

  function fitTarget(key) {
    const right = Array(featureCount).fill(0);
    points.forEach((point, index) => {
      for (let j = 0; j < featureCount; j += 1) right[j] += rows[index][j] * point[key];
    });
    return solveLinearSystem(normal, right);
  }

  const coefficientsX = fitTarget("targetX");
  const coefficientsY = fitTarget("targetY");
  if (
    !coefficientsX || !coefficientsY ||
    [...coefficientsX, ...coefficientsY].some((value) => !Number.isFinite(value))
  ) return null;

  return { meanX, meanY, scaleX, scaleY, coefficientsX, coefficientsY };
}
function predictDocumentPoint(position, mapping) {
  if (!position || !mapping) return null;
  const row = gazeFeatures(
    (position.x - mapping.meanX) / mapping.scaleX,
    (position.verticalSignal - mapping.meanY) / mapping.scaleY,
  );
  return {
    x: row.reduce((sum, value, index) => sum + value * mapping.coefficientsX[index], 0),
    y: row.reduce((sum, value, index) => sum + value * mapping.coefficientsY[index], 0),
  };
}

// The model predicts document coordinates so normal scrolling does not invalidate
// calibration. Selection is allowed only while the predicted point remains in the
// phrase-button region captured during calibration.
function mapGazeToScreen(position, mapping, boardBounds) {
  const predicted = predictDocumentPoint(position, mapping);
  if (!predicted || !boardBounds || !window.innerWidth || !window.innerHeight) return null;

  const insideBoard =
    predicted.x >= boardBounds.left && predicted.x <= boardBounds.right &&
    predicted.y >= boardBounds.top && predicted.y <= boardBounds.bottom;
  // Show the real model prediction rather than pinning the dot to the board edge.
  // Selection remains blocked whenever the unbounded prediction is outside the board.
  return {
    x: (predicted.x - window.scrollX) / window.innerWidth,
    y: (predicted.y - window.scrollY) / window.innerHeight,
    insideBoard,
  };
}

// Create 16 calibration targets from the four visible phrase buttons.
// Each target is positioned inside a button's own rectangle, not inside a
// broad board bounding-box that could put targets into gaps between cards.
// CSS keeps the board at 2×2; use Category=All so all four tiles are present.
function createBoardCalibrationTargets() {
  const buttons = Array.from(
    document.querySelectorAll(".phrase-grid .phrase-select[data-gaze-phrase-id]")
  );

  if (buttons.length !== 4) {
    return {
      targets: null,
      bounds: null,
      error: "For board calibration, set Category to All and make sure exactly four phrase tiles are visible on the current page.",
    };
  }

  const entries = buttons.map((button, tileIndex) => ({
    button,
    tileIndex,
    rect: button.getBoundingClientRect(),
    phraseText: button.getAttribute("data-gaze-phrase-text") || `Tile ${tileIndex + 1}`,
  }));

  if (entries.some(({ rect }) => rect.width <= 0 || rect.height <= 0)) {
    return {
      targets: null,
      bounds: null,
      error: "The phrase buttons are not visible. Scroll the communication board into view and try again.",
    };
  }

  // Require the full button geometry to be visible, otherwise clipped rectangles
  // would silently shift the calibration points and corrupt the mapping.
  const fullyVisible = entries.every(({ rect }) =>
    rect.left >= 0 && rect.top >= 0 &&
    rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
  );
  if (!fullyVisible) {
    return {
      targets: null,
      bounds: null,
      error: "All four phrase buttons must fit inside the browser window during calibration. Please resize or zoom out, then retry.",
    };
  }

  const targets = [];
  for (const entry of entries) {
    for (const point of POINTS_PER_TILE) {
      const clientX = entry.rect.left + entry.rect.width * point.x;
      const clientY = entry.rect.top + entry.rect.height * point.y;
      targets.push({
        x: clientX / window.innerWidth,
        y: clientY / window.innerHeight,
        targetX: clientX + window.scrollX,
        targetY: clientY + window.scrollY,
        label: `Tile ${entry.tileIndex + 1} · ${point.label}`,
        phraseText: entry.phraseText,
      });
    }
  }

  if (targets.length !== CALIBRATION_TARGET_COUNT) {
    return {
      targets: null,
      bounds: null,
      error: `Expected ${CALIBRATION_TARGET_COUNT} calibration targets but could not create them. Please retry.`,
    };
  }

  const visibleBounds = {
    left: Math.min(...entries.map(({ rect }) => rect.left)),
    right: Math.max(...entries.map(({ rect }) => rect.right)),
    top: Math.min(...entries.map(({ rect }) => rect.top)),
    bottom: Math.max(...entries.map(({ rect }) => rect.bottom)),
  };
  const width = visibleBounds.right - visibleBounds.left;
  const height = visibleBounds.bottom - visibleBounds.top;
  if (width < 220 || height < 140) {
    return {
      targets: null,
      bounds: null,
      error: "The visible phrase-board area is too small for calibration. Zoom out or resize the window, then retry.",
    };
  }

  return {
    targets,
    bounds: {
      left: visibleBounds.left + window.scrollX,
      right: visibleBounds.right + window.scrollX,
      top: visibleBounds.top + window.scrollY,
      bottom: visibleBounds.bottom + window.scrollY,
    },
  };
}

export default function GazeTracker() {
  const videoRef = useRef(null);
  const landmarkerRef = useRef(null);
  const streamRef = useRef(null);
  const animationRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);
  const mountedRef = useRef(false);

  const calibrationActiveRef = useRef(false);
  const calibrationIndexRef = useRef(0);
  const currentTargetSamplesRef = useRef([]);
  const calibrationPointsRef = useRef([]);
  const calibrationTargetsRef = useRef([]);
  const calibrationBoundsRef = useRef(null);
  const gazeMappingRef = useRef(null);
  const gazeMarkerEnabledRef = useRef(false);
  const smoothedMarkerRef = useRef(null);
  const dwellTargetRef = useRef(null);
  const lastDwellUiUpdateRef = useRef(0);
  const blinkStateRef = useRef(makeInitialBlinkState());
  const calibrationWorkflowActiveRef = useRef(false);
  const blinkReadyRef = useRef(false);

  const [blinkStatus, setBlinkStatus] = useState("Start the camera to learn your open-eye baseline.");
  const [status, setStatus] = useState("idle");
  const [statusMessage, setStatusMessage] = useState("Camera not started");
  const [faceDetected, setFaceDetected] = useState(false);
  const [landmarkCount, setLandmarkCount] = useState(0);
  const [eyePosition, setEyePosition] = useState(null);
  const [eyeDiagnostics, setEyeDiagnostics] = useState(null);
  const [eyeDirection, setEyeDirection] = useState("—");
  const [calibrationState, setCalibrationState] = useState("idle");
  const [calibrationIndex, setCalibrationIndex] = useState(0);
  const [calibrationPoints, setCalibrationPoints] = useState([]);
  const [calibrationTargets, setCalibrationTargets] = useState([]);
  const [calibrationSampleCount, setCalibrationSampleCount] = useState(0);
  const [gazeMarkerEnabled, setGazeMarkerEnabled] = useState(false);
  const [mappedGaze, setMappedGaze] = useState(null);
  const [dwellStatus, setDwellStatus] = useState("Calibrate first, then enable gaze tile selection.");
  const [dwellProgress, setDwellProgress] = useState(0);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  function resetCalibration() {
    calibrationWorkflowActiveRef.current = false;
    calibrationActiveRef.current = false;
    calibrationIndexRef.current = 0;
    currentTargetSamplesRef.current = [];
    calibrationPointsRef.current = [];
    calibrationTargetsRef.current = [];
    calibrationBoundsRef.current = null;
    gazeMappingRef.current = null;
    setCalibrationTargets([]);
    setCalibrationState("idle");
    setCalibrationIndex(0);
    setCalibrationPoints([]);
    setCalibrationSampleCount(0);
    gazeMarkerEnabledRef.current = false;
    setGazeMarkerEnabled(false);
    setMappedGaze(null);
    smoothedMarkerRef.current = null;
    dwellTargetRef.current = null;
    setDwellProgress(0);
    setDwellStatus("Calibrate first, then enable gaze tile selection.");
    window.dispatchEvent(new CustomEvent("irisvocal:reset-gaze-selection"));
  }

  function stopCamera() {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    lastVideoTimeRef.current = -1;
    resetCalibration();

    setFaceDetected(false);
    setLandmarkCount(0);
    setEyePosition(null);
    setEyeDiagnostics(null);
    setEyeDirection("—");
    setStatus("idle");
    setStatusMessage("Camera stopped");
    blinkStateRef.current = makeInitialBlinkState();
    blinkReadyRef.current = false;
    setBlinkStatus("Start the camera to learn your open-eye baseline.");
    window.dispatchEvent(new CustomEvent("irisvocal:tracking-status", { detail: { status: "idle" } }));
  }

  async function startCalibration() {
    if (status !== "running" || !faceDetected) return;

    calibrationWorkflowActiveRef.current = true;
    gazeMarkerEnabledRef.current = false;
    setGazeMarkerEnabled(false);
    setMappedGaze(null);
    smoothedMarkerRef.current = null;
    dwellTargetRef.current = null;
    gazeMappingRef.current = null;
    setCalibrationState("idle");
    window.dispatchEvent(new CustomEvent("irisvocal:reset-gaze-selection"));

    const phraseGrid = document.querySelector(".phrase-grid");
    if (!phraseGrid) {
      calibrationWorkflowActiveRef.current = false;
      setStatusMessage("Could not find the communication board. Keep the phrase grid mounted, then try again.");
      return;
    }

    setStatusMessage("Bringing the communication board into view for board-specific calibration…");
    phraseGrid.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    // Wait for scrolling/layout to settle before reading actual button coordinates.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!mountedRef.current) return;

    const calibration = createBoardCalibrationTargets();
    if (!calibration.targets || !calibration.bounds) {
      calibrationWorkflowActiveRef.current = false;
      setStatusMessage(calibration.error || "Could not determine the phrase-board calibration area.");
      return;
    }

    calibrationIndexRef.current = 0;
    currentTargetSamplesRef.current = [];
    calibrationPointsRef.current = [];
    calibrationTargetsRef.current = calibration.targets;
    calibrationBoundsRef.current = calibration.bounds;
    gazeMappingRef.current = null;
    calibrationActiveRef.current = false;
    setCalibrationIndex(0);
    setCalibrationPoints([]);
    setCalibrationTargets(calibration.targets);
    setCalibrationSampleCount(0);
    gazeMarkerEnabledRef.current = false;
    setGazeMarkerEnabled(false);
    setMappedGaze(null);
    smoothedMarkerRef.current = null;
    dwellTargetRef.current = null;
    setCalibrationState("waiting");
    setStatusMessage("Look at each target positioned over your communication board. Keep your head as still as comfortable.");
  }
  function beginTargetCapture() {
    if (status !== "running" || !faceDetected) return;
    currentTargetSamplesRef.current = [];
    setCalibrationSampleCount(0);
    calibrationActiveRef.current = true;
    setCalibrationState("collecting");
    setStatusMessage("Collecting samples. Keep looking at the target until capture finishes.");
  }

  function moveToNextTarget() {
    const nextIndex = calibrationIndexRef.current + 1;
    if (nextIndex >= calibrationTargetsRef.current.length) return;
    calibrationIndexRef.current = nextIndex;
    currentTargetSamplesRef.current = [];
    setCalibrationSampleCount(0);
    setCalibrationIndex(nextIndex);
    setCalibrationState("waiting");
    setStatusMessage(`Move your eyes to ${calibrationTargetsRef.current[nextIndex].label.toLowerCase()}, then start capture when ready.`);
  }

  function cancelCalibration() {
    resetCalibration();
    setStatusMessage("Calibration cancelled. You can start again when ready.");
  }

  function toggleGazeMarker() {
    const nextEnabled = !gazeMarkerEnabledRef.current;
    gazeMarkerEnabledRef.current = nextEnabled;
    setGazeMarkerEnabled(nextEnabled);
    setMappedGaze(null);
    smoothedMarkerRef.current = null;
    dwellTargetRef.current = null;
    setDwellProgress(0);
    window.dispatchEvent(new CustomEvent("irisvocal:reset-gaze-selection"));
    setStatusMessage(
      nextEnabled
        ? "Gaze tile selection active. Look at one tile and hold your gaze for 1.5 seconds to select and speak it."
        : "Gaze tile selection stopped."
    );
  }

  async function startCamera() {
    if (status === "starting" || status === "running") return;

    setStatus("starting");
    setStatusMessage("Requesting camera permission…");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is unavailable. Use localhost or HTTPS in a supported browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        },
      });

      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Camera preview element was not found.");

      video.srcObject = stream;
      await video.play();

      setStatusMessage("Loading face landmark model…");
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      if (!mountedRef.current) {
        landmarker.close();
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      landmarkerRef.current = landmarker;
      blinkStateRef.current = makeInitialBlinkState();
      blinkReadyRef.current = false;
      setBlinkStatus("Keep both eyes comfortably open for a moment to initialize blink detection.");
      setStatus("running");
      setStatusMessage("Camera active — looking for a face…");
      window.dispatchEvent(new CustomEvent("irisvocal:tracking-status", { detail: { status: "running" } }));

      const detectFrame = () => {
        if (!mountedRef.current || !videoRef.current || !landmarkerRef.current) return;

        const currentVideo = videoRef.current;
        const currentLandmarker = landmarkerRef.current;

        if (
          currentVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          currentVideo.currentTime !== lastVideoTimeRef.current
        ) {
          lastVideoTimeRef.current = currentVideo.currentTime;

          try {
            const result = currentLandmarker.detectForVideo(currentVideo, performance.now());
            const landmarks = result.faceLandmarks?.[0];

            if (landmarks?.length) {
              const blinkDurationMs = detectIntentionalBlink(
                landmarks,
                blinkStateRef.current,
                performance.now()
              );
              const blinkReady = blinkStateRef.current.baselines.every(
                (baseline) => Number.isFinite(baseline) && baseline > 0.09
              );
              if (blinkReady !== blinkReadyRef.current) {
                blinkReadyRef.current = blinkReady;
                setBlinkStatus(
                  blinkReady
                    ? "Ready: hold both eyes closed for a deliberate long blink, reopen, then blink again to confirm SOS."
                    : "Learning open-eye baseline… keep both eyes comfortably open."
                );
              }
              if (blinkDurationMs != null && !calibrationWorkflowActiveRef.current) {
                setBlinkStatus("Long blink detected. Blink deliberately again within 8 seconds to confirm SOS.");
                window.dispatchEvent(new CustomEvent("irisvocal:sos-blink", {
                  detail: { durationMs: blinkDurationMs }
                }));
              }

              const perEye = EYES.map((eye) => getEyeRatios(landmarks, eye));
              const position = estimateEyePosition(landmarks);
              setEyeDiagnostics(perEye);
              setFaceDetected(true);
              setLandmarkCount(landmarks.length);
              setEyePosition(position);
              setEyeDirection(classifyPosition(position));

              if (gazeMarkerEnabledRef.current && position) {
                const rawMapped = mapGazeToScreen(position, gazeMappingRef.current, calibrationBoundsRef.current);
                if (rawMapped) {
                  const previous = smoothedMarkerRef.current;
                  if (!previous) {
                    smoothedMarkerRef.current = rawMapped;
                  } else {
                    // Horizontal measurements are stronger, so keep them more responsive.
                    // Vertical measurements are noisier, so smooth them, but not so heavily that movement feels stuck.
                    const horizontalAlpha = 0.30;
                    const verticalAlpha = 0.28;
                    const horizontalDelta = rawMapped.x - previous.x;
                    const verticalDelta = rawMapped.y - previous.y;
                    // Snap after scrolling or a large gaze jump; otherwise smooth small noise.
                    const snapToRaw = Math.abs(horizontalDelta) > 0.12 || Math.abs(verticalDelta) > 0.12;
                    const nextX = snapToRaw || Math.abs(horizontalDelta) < 0.004
                      ? rawMapped.x
                      : previous.x + horizontalAlpha * horizontalDelta;
                    const nextY = snapToRaw || Math.abs(verticalDelta) < 0.004
                      ? rawMapped.y
                      : previous.y + verticalAlpha * verticalDelta;
                    smoothedMarkerRef.current = { x: nextX, y: nextY, insideBoard: rawMapped.insideBoard };
                  }
                  setMappedGaze(smoothedMarkerRef.current);

                  // Only select while the predicted gaze point remains in the captured phrase-button area.
                  const gazePoint = smoothedMarkerRef.current;
                  const hit = gazePoint.insideBoard
                    ? document.elementFromPoint(
                        gazePoint.x * window.innerWidth,
                        gazePoint.y * window.innerHeight
                      )
                    : null;
                  const tile = hit?.closest?.("[data-gaze-phrase-id]");
                  const now = performance.now();

                  if (tile) {
                    const phraseId = tile.getAttribute("data-gaze-phrase-id");
                    const phraseText = tile.getAttribute("data-gaze-phrase-text") || "";
                    let dwell = dwellTargetRef.current;

                    if (!dwell || dwell.phraseId !== phraseId) {
                      if (dwell) window.dispatchEvent(new CustomEvent("irisvocal:reset-gaze-selection"));
                      dwell = { phraseId, phraseText, startedAt: now, selected: false };
                      dwellTargetRef.current = dwell;
                      setDwellProgress(0);
                      setDwellStatus(`Looking at “${phraseText}”… hold for 1.5 seconds.`);
                    }

                    const progress = Math.min(1, (now - dwell.startedAt) / 1500);
                    if (now - lastDwellUiUpdateRef.current > 100) {
                      lastDwellUiUpdateRef.current = now;
                      setDwellProgress(progress);
                      if (!dwell.selected) {
                        setDwellStatus(`Hold on “${phraseText}” — ${Math.max(0, 1.5 - (now - dwell.startedAt) / 1000).toFixed(1)}s`);
                      }
                    }

                    if (progress >= 1 && !dwell.selected) {
                      dwell.selected = true;
                      window.dispatchEvent(new CustomEvent("irisvocal:select-phrase", {
                        detail: { phraseId, phraseText }
                      }));
                      setDwellProgress(1);
                      setDwellStatus(`Selected “${phraseText}”. Look away before selecting another tile.`);
                    }
                  } else {
                    if (dwellTargetRef.current) window.dispatchEvent(new CustomEvent("irisvocal:reset-gaze-selection"));
                    dwellTargetRef.current = null;
                    if (now - lastDwellUiUpdateRef.current > 100) {
                      lastDwellUiUpdateRef.current = now;
                      setDwellProgress(0);
                      setDwellStatus("Look at a communication tile to begin selection.");
                    }
                  }
                }
              }

              if (calibrationActiveRef.current && position) {
                currentTargetSamplesRef.current.push(position);
                setCalibrationSampleCount(currentTargetSamplesRef.current.length);

                if (currentTargetSamplesRef.current.length >= SAMPLES_PER_TARGET) {
                  const targetIndex = calibrationIndexRef.current;
                  const target = calibrationTargetsRef.current[targetIndex];
                  const average = averageSamples(currentTargetSamplesRef.current);
                  const point = {
                    target: target.label,
                    targetX: target.targetX,
                    targetY: target.targetY,
                    irisX: Number(average.x.toFixed(4)),
                    irisY: Number(average.y.toFixed(4)),
                    verticalSignal: Number(average.verticalSignal.toFixed(5)),
                    sampleCount: currentTargetSamplesRef.current.length,
                  };

                  const nextPoints = [...calibrationPointsRef.current, point];
                  calibrationPointsRef.current = nextPoints;
                  setCalibrationPoints(nextPoints);
                  currentTargetSamplesRef.current = [];
                  setCalibrationSampleCount(SAMPLES_PER_TARGET);
                  calibrationActiveRef.current = false;

                  if (targetIndex + 1 >= calibrationTargetsRef.current.length) {
                    calibrationWorkflowActiveRef.current = false;
                    const fittedMapping = fitGazeMapping(nextPoints);
                    if (!fittedMapping || !calibrationBoundsRef.current) {
                      gazeMappingRef.current = null;
                      setCalibrationState("idle");
                      setStatusMessage("These samples did not produce a stable mapping. Keep your head steady and run calibration again.");
                    } else {
                      gazeMappingRef.current = fittedMapping;
                      setCalibrationState("complete");
                      setStatusMessage(
                        "All 16 board targets captured. Enable gaze selection and test the marker on multiple tiles before relying on it."
                      );
                    }
                  } else {
                    setCalibrationState("target-complete");
                    setStatusMessage(
                      `${target.label} captured. Click Next target when you are ready to continue.`
                    );
                  }
                }
              } else if (!calibrationActiveRef.current) {
                setStatusMessage(
                  position
                    ? "Face and iris landmarks detected — eye position estimate updating"
                    : "Face detected, but iris landmarks are unavailable"
                );
              }
            } else {
              setFaceDetected(false);
              setLandmarkCount(0);
              setEyePosition(null);
              setEyeDiagnostics(null);
              setEyeDirection("—");
              if (dwellTargetRef.current) window.dispatchEvent(new CustomEvent("irisvocal:reset-gaze-selection"));
              dwellTargetRef.current = null;
              setDwellProgress(0);
              if (calibrationActiveRef.current) {
                setStatusMessage("Face lost — look back at the target to continue calibration.");
              } else {
                setStatusMessage("Camera active — move into view");
              }
            }
          } catch (error) {
            console.error("Face landmark detection failed:", error);
            calibrationActiveRef.current = false;
            setStatus("error");
            window.dispatchEvent(new CustomEvent("irisvocal:tracking-status", { detail: { status: "error" } }));
            setStatusMessage("Face detection stopped. Check the browser console.");
            return;
          }
        }

        animationRef.current = requestAnimationFrame(detectFrame);
      };

      animationRef.current = requestAnimationFrame(detectFrame);
    } catch (error) {
      console.error("Could not start IrisVocal camera tracking:", error);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
      setStatus("error");
      window.dispatchEvent(new CustomEvent("irisvocal:tracking-status", { detail: { status: "error" } }));
      setStatusMessage(
        error?.name === "NotAllowedError"
          ? "Camera permission was denied. Allow camera access in your browser settings, then try again."
          : error?.message || "Could not start camera tracking."
      );
    }
  }

  const activeTarget =
    ["waiting", "collecting", "target-complete"].includes(calibrationState)
      ? calibrationTargets[Math.min(calibrationIndex, calibrationTargets.length - 1)]
      : null;

  return (
    <section className="gaze-tracker" aria-labelledby="gaze-tracker-title">
      {gazeMarkerEnabled && mappedGaze && calibrationState === "complete" && (
        <div
  className="gaze-live-marker"
  style={{
    position: "fixed",
    left: `${mappedGaze.x * 100}vw`,
    top: `${mappedGaze.y * 100}vh`,
    transform: "translate(-50%, -50%)",
    zIndex: 9999,
    pointerEvents: "none",
  }}
  aria-label="Estimated gaze position marker"
>
          <span />
        </div>
      )}
      {gazeMarkerEnabled && !mappedGaze && calibrationState === "complete" && (
        <div className="gaze-live-marker-label">Gaze marker waiting for a valid estimate…</div>
      )}
      {activeTarget && (
        <div className="gaze-calibration-overlay" role="status" aria-live="polite">
          <div className="gaze-calibration-instructions">
            <strong>Calibration · Target {calibrationIndex + 1} of {calibrationTargets.length}: {activeTarget.label}</strong>
            {calibrationState === "waiting" && (
              <>
                <span>Look at the dot inside “{activeTarget.phraseText}”. It will stay here until you capture this target.</span>
                <button type="button" onClick={beginTargetCapture} disabled={!faceDetected}>
                  Capture this target
                </button>
              </>
            )}
            {calibrationState === "collecting" && (
              <>
                <span>Keep looking at the dot inside “{activeTarget.phraseText}” while samples are captured.</span>
                <span>Samples: {calibrationSampleCount} / {SAMPLES_PER_TARGET}</span>
              </>
            )}
            {calibrationState === "target-complete" && (
              <>
                <span>Target captured. Take your time before moving to the next dot.</span>
                <button type="button" onClick={moveToNextTarget}>Next target</button>
              </>
            )}
            <button type="button" onClick={cancelCalibration}>Cancel calibration</button>
          </div>
          <div
            className="gaze-calibration-target"
            style={{ left: `${activeTarget.x * 100}%`, top: `${activeTarget.y * 100}%` }}
            aria-label={`Look at ${activeTarget.label}`}
          />
        </div>
      )}

      <div className="gaze-tracker-heading">
        <div>
          <p className="gaze-tracker-kicker">MEMBER 1 · STAGE 3</p>
          <h2 id="gaze-tracker-title">Eye-position calibration</h2>
          <p className="gaze-tracker-description">
            Calibration places four targets inside each of the four visible phrase buttons (16 total) and fits both gaze signals together. Set Category to All and recalibrate after changing zoom or window size.
            After calibration, enable experimental tile selection. A deliberate long blink can open the SOS confirmation prompt; a second deliberate long blink confirms it. SOS blink gestures work only while this camera is running and are experimental.
          </p>
        </div>
        <span className={`gaze-status-pill gaze-status-${status}`}>
          <span className="gaze-status-dot" />
          {status === "running"
            ? faceDetected ? "Face detected" : "Camera active"
            : status === "starting" ? "Starting"
            : status === "error" ? "Needs attention"
            : "Not connected"}
        </span>
      </div>

      <div className="gaze-tracker-body">
        <div className="gaze-camera-frame">
          <video
            ref={videoRef}
            className="gaze-camera-video"
            autoPlay
            muted
            playsInline
            aria-label="Mirrored webcam preview"
          />
          {status !== "running" && (
            <div className="gaze-camera-placeholder">
              <span className="gaze-camera-icon">◎</span>
              <span>Camera preview appears here</span>
            </div>
          )}
          {status === "running" && faceDetected && (
            <span className="gaze-face-indicator">Face landmarks detected</span>
          )}
        </div>

        <div className="gaze-tracker-details">
          <p className="gaze-status-message" role="status" aria-live="polite">
            {statusMessage}
          </p>
          <div className="gaze-metric"><span>Face detected</span><strong>{faceDetected ? "Yes" : "No"}</strong></div>
          <div className="gaze-metric"><span>SOS blink detection</span><strong>{blinkReadyRef.current ? "Ready" : status === "running" ? "Learning" : "Camera off"}</strong></div>
          <p className="gaze-status-message" aria-live="polite">{blinkStatus}</p>
          <div className="gaze-metric"><span>Landmarks in current frame</span><strong>{landmarkCount || "—"}</strong></div>
          <div className="gaze-metric"><span>Estimated eye position</span><strong>{eyeDirection}</strong></div>
          <div className="gaze-metric"><span>Horizontal iris ratio</span><strong>{eyePosition ? eyePosition.x.toFixed(2) : "—"}</strong></div>
          <div className="gaze-metric"><span>Vertical iris ratio (combined)</span><strong>{eyePosition ? eyePosition.y.toFixed(3) : "—"}</strong></div>

          <div className="gaze-eye-diagnostics">
            <strong>Live vertical diagnostic — each eye</strong>
            <p>Keep your head still. Look center, up, then down and watch the raw offset and eye opening for each eye.</p>
            <div className="gaze-calibration-table-wrap">
              <table className="gaze-calibration-table">
                <thead>
                  <tr><th>Measurement</th><th>Eye A</th><th>Eye B</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Horizontal ratio</td>
                    <td>{eyeDiagnostics?.[0] ? eyeDiagnostics[0].x.toFixed(3) : "—"}</td>
                    <td>{eyeDiagnostics?.[1] ? eyeDiagnostics[1].x.toFixed(3) : "—"}</td>
                  </tr>
                  <tr>
                    <td>Vertical ratio</td>
                    <td>{eyeDiagnostics?.[0] ? eyeDiagnostics[0].y.toFixed(3) : "—"}</td>
                    <td>{eyeDiagnostics?.[1] ? eyeDiagnostics[1].y.toFixed(3) : "—"}</td>
                  </tr>
                  <tr>
                    <td>Raw vertical offset</td>
                    <td>{eyeDiagnostics?.[0] ? eyeDiagnostics[0].rawVerticalOffset.toFixed(3) : "—"}</td>
                    <td>{eyeDiagnostics?.[1] ? eyeDiagnostics[1].rawVerticalOffset.toFixed(3) : "—"}</td>
                  </tr>
                  <tr>
                    <td>Eye opening</td>
                    <td>{eyeDiagnostics?.[0] ? eyeDiagnostics[0].eyeOpening.toFixed(4) : "—"}</td>
                    <td>{eyeDiagnostics?.[1] ? eyeDiagnostics[1].eyeOpening.toFixed(4) : "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="gaze-calibration-actions">
            <button
              type="button"
              className="gaze-start-button"
              onClick={startCalibration}
              disabled={status !== "running" || !faceDetected || ["waiting", "collecting", "target-complete"].includes(calibrationState)}
            >
              {["waiting", "collecting", "target-complete"].includes(calibrationState) ? "Calibration in progress…" : "Start 16-point board calibration"}
            </button>
            {calibrationState === "running" && (
              <button type="button" className="gaze-stop-button" onClick={cancelCalibration}>
                Cancel
              </button>
            )}
            {calibrationState === "complete" && (
              <>
                <button type="button" className="gaze-stop-button" onClick={startCalibration}>
                  Calibrate again
                </button>
                <button
                  type="button"
                  className="gaze-start-button"
                  onClick={toggleGazeMarker}
                  disabled={status !== "running" || !faceDetected}
                >
                  {gazeMarkerEnabled ? "Stop gaze tile selection" : "Enable gaze tile selection"}
                </button>
              </>
            )}
          </div>

          {calibrationState === "complete" && (
            <div className="gaze-calibration-results" role="status">
              <strong>Sixteen board targets captured</strong>
              <p>These samples create an experimental 2D quadratic mapping from both gaze signals, trained on four positions inside each visible phrase button. This is not a validated gaze model; test the marker on several phrase tiles before relying on selection.</p>
              <div className="gaze-calibration-table-wrap">
                <table className="gaze-calibration-table">
                  <thead><tr><th>Target</th><th>Iris X</th><th>Vertical signal</th><th>Samples</th></tr></thead>
                  <tbody>
                    {calibrationPoints.map((point) => (
                      <tr key={point.target}>
                        <td>{point.target}</td>
                        <td>{point.irisX.toFixed(3)}</td>
                        <td>{point.verticalSignal.toFixed(4)}</td>
                        <td>{point.sampleCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="gaze-privacy-note">
            Camera frames are processed in this browser. Calibration data stays in
            component memory and is not uploaded or saved between page reloads.
          </p>
          {calibrationState === "complete" && gazeMarkerEnabled && (
            <div className="gaze-dwell-status" role="status" aria-live="polite">
              <div className="gaze-dwell-status-text">{dwellStatus}</div>
              <div className="gaze-dwell-progress" aria-label={`Dwell progress ${Math.round(dwellProgress * 100)} percent`}>
                <span style={{ width: `${dwellProgress * 100}%` }} />
              </div>
            </div>
          )}
          <div className="gaze-tracker-actions">
            <button type="button" className="gaze-start-button" onClick={startCamera} disabled={status === "starting" || status === "running"}>
              {status === "starting" ? "Starting…" : "Start camera"}
            </button>
            <button type="button" className="gaze-stop-button" onClick={stopCamera} disabled={status === "idle" || status === "starting"}>
              Stop camera
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}