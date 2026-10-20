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

// Target coordinates are normalized to the browser viewport.
const CALIBRATION_TARGETS = [
  { x: 0.12, y: 0.14, label: "Top left" },
  { x: 0.88, y: 0.14, label: "Top right" },
  { x: 0.5, y: 0.5, label: "Center" },
  { x: 0.12, y: 0.86, label: "Bottom left" },
  { x: 0.88, y: 0.86, label: "Bottom right" },
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

// Fit x/y screen coordinates from the five calibration samples using least squares.
// This is a simple diagnostic mapping, not a medically validated gaze model.
function solve3x3(matrix, vector) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j < 4; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j < 4; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[3]);
}

// Fit each screen axis independently. The calibration data shows that iris X
// separates left/right targets more reliably than iris Y separates top/bottom.
// Keeping the axes independent prevents noisy vertical readings from shifting X,
// and prevents horizontal readings from distorting Y.
function fitLinearAxis(points, inputKey, targetKey) {
  if (!points || points.length < 2) return null;

  const meanInput = points.reduce((sum, point) => sum + point[inputKey], 0) / points.length;
  const meanTarget = points.reduce((sum, point) => sum + point[targetKey], 0) / points.length;

  let covariance = 0;
  let variance = 0;
  points.forEach((point) => {
    const inputDelta = point[inputKey] - meanInput;
    covariance += inputDelta * (point[targetKey] - meanTarget);
    variance += inputDelta * inputDelta;
  });

  // If the eye signal barely changes across targets, mapping it to the screen
  // would amplify noise. In that case, refuse to produce a misleading estimate.
  if (variance < 0.00005) return null;

  const slope = covariance / variance;
  const intercept = meanTarget - slope * meanInput;
  return { slope, intercept };
}

function fitAxisMapping(points) {
  if (!points || points.length < 3) return null;
  const x = fitLinearAxis(points, "irisX", "targetX");
  const y = fitLinearAxis(points, "verticalSignal", "targetY");
  return x && y ? { x, y } : null;
}

function mapGazeToScreen(position, points) {
  if (!position || points.length < 3) return null;
  const mapping = fitAxisMapping(points);
  if (!mapping) return null;

  const x = mapping.x.slope * position.x + mapping.x.intercept;
  const y =
  mapping.y.slope * position.verticalSignal +
  mapping.y.intercept +
  0.03;

  return {
    x: Math.max(0.02, Math.min(0.98, x)),
    y: Math.max(0.04, Math.min(0.96, y)),
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
  const gazeMarkerEnabledRef = useRef(false);
  const smoothedMarkerRef = useRef(null);
  const dwellTargetRef = useRef(null);
  const lastDwellUiUpdateRef = useRef(0);

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
    calibrationActiveRef.current = false;
    calibrationIndexRef.current = 0;
    currentTargetSamplesRef.current = [];
    calibrationPointsRef.current = [];
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
  }

  function startCalibration() {
    if (status !== "running" || !faceDetected) return;
    calibrationIndexRef.current = 0;
    currentTargetSamplesRef.current = [];
    calibrationPointsRef.current = [];
    calibrationActiveRef.current = false;
    setCalibrationIndex(0);
    setCalibrationPoints([]);
    setCalibrationSampleCount(0);
    gazeMarkerEnabledRef.current = false;
    setGazeMarkerEnabled(false);
    setMappedGaze(null);
    smoothedMarkerRef.current = null;
    setCalibrationState("waiting");
    setStatusMessage("Move your eyes to the target. Start capturing only when you are ready.");
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
    if (nextIndex >= CALIBRATION_TARGETS.length) return;
    calibrationIndexRef.current = nextIndex;
    currentTargetSamplesRef.current = [];
    setCalibrationSampleCount(0);
    setCalibrationIndex(nextIndex);
    setCalibrationState("waiting");
    setStatusMessage(`Move your eyes to ${CALIBRATION_TARGETS[nextIndex].label.toLowerCase()}, then start capture when ready.`);
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
      setStatus("running");
      setStatusMessage("Camera active — looking for a face…");

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
              const perEye = EYES.map((eye) => getEyeRatios(landmarks, eye));
              const position = estimateEyePosition(landmarks);
              setEyeDiagnostics(perEye);
              setFaceDetected(true);
              setLandmarkCount(landmarks.length);
              setEyePosition(position);
              setEyeDirection(classifyPosition(position));

              if (gazeMarkerEnabledRef.current && position) {
                const rawMapped = mapGazeToScreen(position, calibrationPointsRef.current);
                if (rawMapped) {
                  const previous = smoothedMarkerRef.current;
                  if (!previous) {
                    smoothedMarkerRef.current = rawMapped;
                  } else {
                    // Horizontal measurements are stronger, so keep them more responsive.
                    // Vertical measurements are noisier, so smooth them, but not so heavily that movement feels stuck.
                    const horizontalAlpha = 0.30;
                    const verticalAlpha = 0.18;
                    const horizontalDelta = rawMapped.x - previous.x;
                    const verticalDelta = rawMapped.y - previous.y;
                    const nextX = Math.abs(horizontalDelta) < 0.004
                      ? previous.x
                      : previous.x + horizontalAlpha * horizontalDelta;
                    const nextY = Math.abs(verticalDelta) < 0.006
                      ? previous.y
                      : previous.y + verticalAlpha * verticalDelta;
                    smoothedMarkerRef.current = { x: nextX, y: nextY };
                  }
                  setMappedGaze(smoothedMarkerRef.current);

                  // Experimental dwell selection: hit-test the calibrated gaze point against phrase tiles.
                  const gazePoint = smoothedMarkerRef.current;
                  const hit = document.elementFromPoint(
                    gazePoint.x * window.innerWidth,
                    gazePoint.y * window.innerHeight
                  );
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
                  const target = CALIBRATION_TARGETS[targetIndex];
                  const average = averageSamples(currentTargetSamplesRef.current);
                  const point = {
                    target: target.label,
                    targetX: target.x,
                    targetY: target.y,
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

                  if (targetIndex + 1 >= CALIBRATION_TARGETS.length) {
                    setCalibrationState("complete");
                    setStatusMessage(
                      "All five targets captured. Review the measurements before implementing gaze selection."
                    );
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
      setStatusMessage(
        error?.name === "NotAllowedError"
          ? "Camera permission was denied. Allow camera access in your browser settings, then try again."
          : error?.message || "Could not start camera tracking."
      );
    }
  }

  const activeTarget =
    ["waiting", "collecting", "target-complete"].includes(calibrationState)
      ? CALIBRATION_TARGETS[Math.min(calibrationIndex, CALIBRATION_TARGETS.length - 1)]
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
            <strong>Calibration · Target {calibrationIndex + 1} of {CALIBRATION_TARGETS.length}: {activeTarget.label}</strong>
            {calibrationState === "waiting" && (
              <>
                <span>Take your time moving your eyes to the dot. It will stay here until you choose to capture.</span>
                <button type="button" onClick={beginTargetCapture} disabled={!faceDetected}>
                  Capture this target
                </button>
              </>
            )}
            {calibrationState === "collecting" && (
              <>
                <span>Keep looking at the dot while the app captures its samples.</span>
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
            Calibration records iris ratios while you look at five screen targets. Vertical position is measured relative to the eye-corner line.
            After calibration, enable experimental tile selection. Hold your gaze on a tile for 1.5 seconds to select and speak it. Accuracy is not guaranteed.
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
              {["waiting", "collecting", "target-complete"].includes(calibrationState) ? "Calibration in progress…" : "Start 5-point calibration"}
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
              <strong>Five target samples captured</strong>
              <p>These samples create an experimental screen mapping, not a validated gaze model. Test the marker before relying on tile selection.</p>
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