
import { useEffect, useRef, useState } from "react";
import "./App.css";
import Auth from "./Auth";

const initialPhrases = [
  { id: 1, text: "I need help", category: "General", icon: "✚" },
  { id: 2, text: "I want water", category: "General", icon: "▤" },
  { id: 3, text: "I am hungry", category: "General", icon: "♨" },
  { id: 4, text: "I feel pain", category: "Health", icon: "♥" },
  { id: 5, text: "I feel cold", category: "Health", icon: "❄" },
  { id: 6, text: "I need medicine", category: "Health", icon: "✚" },
  { id: 7, text: "Please call my family", category: "Social", icon: "♧" },
  { id: 8, text: "I need a break", category: "Social", icon: "Ⅱ" },
  { id: 9, text: "I need assistance", category: "Safety", icon: "!" },
  { id: 10, text: "Thank you", category: "Social", icon: "♡" },
  { id: 11, text: "Yes", category: "General", icon: "✓" },
  { id: 12, text: "No", category: "General", icon: "×" },
];

const categories = ["All", "General", "Health", "Social", "Safety"];

function App() {
  return <Auth />;
  const [phrases, setPhrases] = useState(() => {
    try {
      const savedPhrases = localStorage.getItem("irisvocal-phrases");

      if (savedPhrases !== null) {
        const parsedPhrases = JSON.parse(savedPhrases);

        if (Array.isArray(parsedPhrases)) {
          return parsedPhrases;
        }
      }
    } catch (error) {
      console.error("Could not load saved phrases:", error);
    }

    return initialPhrases;
  });

  useEffect(() => {
    try {
      localStorage.setItem("irisvocal-phrases", JSON.stringify(phrases));
    } catch (error) {
      console.error("Could not save phrases:", error);
    }
  }, [phrases]);
  const [activeCategory, setActiveCategory] = useState("All");
  const [selectedPhrase, setSelectedPhrase] = useState(null);

  const [newPhrase, setNewPhrase] = useState("");
  const [newCategory, setNewCategory] = useState("General");

  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [editCategory, setEditCategory] = useState("General");

  // Keep mock mode enabled until Member 3 confirms the backend is ready.
  const USE_MOCK_EMERGENCY_API = true;
  const EMERGENCY_API_URL = "http://localhost:8081/api/emergency";
  const EMERGENCY_COOLDOWN_MS = 15000;

  const emergencyInProgressRef = useRef(false);
  const lastEmergencyRequestAtRef = useRef(0);
  const [emergencyStatus, setEmergencyStatus] = useState({
    type: "idle",
    message: "",
    locationUrl: null,
  });

  const visiblePhrases =
    activeCategory === "All"
      ? phrases
      : phrases.filter((phrase) => phrase.category === activeCategory);

  function speakPhrase(text) {
    if (!("speechSynthesis" in window)) {
      window.alert("Speech output is not supported in this browser.");
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  }

  function handlePhraseSelect(phrase) {
    setSelectedPhrase(phrase);
    speakPhrase(phrase.text);
  }

  // Remembers the last phrase selected by gaze so repeated tracking events
  // for the same tile do not repeatedly trigger speech.
  const lastGazePhraseIdRef = useRef(null);

  useEffect(() => {
    function handleGazeSelection(event) {
      const { phraseId, phraseText } = event.detail ?? {};

      const phrase = phrases.find(
        (item) =>
          (phraseId !== undefined &&
            String(item.id) === String(phraseId)) ||
          (phraseText !== undefined && item.text === phraseText)
      );

      if (!phrase) return;

      // Ignore repeated events while gaze remains on the same phrase.
      if (String(lastGazePhraseIdRef.current) === String(phrase.id)) {
        return;
      }

      lastGazePhraseIdRef.current = phrase.id;
      handlePhraseSelect(phrase);
    }

    // The tracking module can dispatch this when gaze leaves a phrase tile.
    // This lets the same phrase be selected again after a new dwell.
    function handleGazeSelectionReset() {
      lastGazePhraseIdRef.current = null;
    }

    window.addEventListener(
      "irisvocal:select-phrase",
      handleGazeSelection
    );
    window.addEventListener(
      "irisvocal:reset-gaze-selection",
      handleGazeSelectionReset
    );

    return () => {
      window.removeEventListener(
        "irisvocal:select-phrase",
        handleGazeSelection
      );
      window.removeEventListener(
        "irisvocal:reset-gaze-selection",
        handleGazeSelectionReset
      );
    };
  }, [phrases]);

  function addPhrase(event) {
    event.preventDefault();
    const text = newPhrase.trim();
    if (!text) return;

    const phrase = {
      id: Date.now(),
      text,
      category: newCategory,
      icon: "•",
    };

    setPhrases((current) => [...current, phrase]);
    setNewPhrase("");
    setActiveCategory("All");
  }

  function startEditing(phrase) {
    setEditingId(phrase.id);
    setEditText(phrase.text);
    setEditCategory(phrase.category);
  }

  function saveEdit(event) {
    event.preventDefault();
    const text = editText.trim();
    if (!text) return;

    const updatedPhrase = {
      ...phrases.find((phrase) => phrase.id === editingId),
      text,
      category: editCategory,
    };

    setPhrases((current) =>
      current.map((phrase) =>
        phrase.id === editingId ? updatedPhrase : phrase
      )
    );

    setSelectedPhrase((current) =>
      current?.id === editingId ? updatedPhrase : current
    );

    setEditingId(null);
    setEditText("");
  }

  function deletePhrase(id) {
    if (!window.confirm("Delete this phrase?")) return;

    setPhrases((current) => current.filter((phrase) => phrase.id !== id));
    setSelectedPhrase((current) => (current?.id === id ? null : current));

    if (editingId === id) {
      setEditingId(null);
      setEditText("");
    }
  }

  function getCurrentLocation() {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("Location services are not supported by this browser."));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        (error) => {
          const messages = {
            1: "Location permission was denied. Please allow location access to send an emergency alert.",
            2: "Your location is currently unavailable. Please try again.",
            3: "Location lookup timed out. Please try again.",
          };
          reject(new Error(messages[error.code] || "Could not get your location."));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  async function submitEmergencyAlert() {
    const now = Date.now();

    if (emergencyInProgressRef.current) {
      setEmergencyStatus({
        type: "info",
        message: "An emergency request is already being processed.",
        locationUrl: null,
      });
      return;
    }

    const timeSinceLastRequest = now - lastEmergencyRequestAtRef.current;
    if (lastEmergencyRequestAtRef.current && timeSinceLastRequest < EMERGENCY_COOLDOWN_MS) {
      const secondsLeft = Math.ceil(
        (EMERGENCY_COOLDOWN_MS - timeSinceLastRequest) / 1000
      );
      setEmergencyStatus({
        type: "info",
        message: `Please wait ${secondsLeft} seconds before trying another alert.`,
        locationUrl: null,
      });
      return;
    }

    emergencyInProgressRef.current = true;
    setEmergencyStatus({
      type: "loading",
      message: "Getting your location…",
      locationUrl: null,
    });

    try {
      const { latitude, longitude } = await getCurrentLocation();
      const requestBody = {
        message: "I need emergency assistance",
        latitude,
        longitude,
      };
      const locationUrl = `https://maps.google.com/?q=${latitude},${longitude}`;

      setEmergencyStatus({
        type: "loading",
        message: "Preparing emergency alert…",
        locationUrl,
      });

      let responseData;

      if (USE_MOCK_EMERGENCY_API) {
        // Safe local testing: this mock does not contact the backend or send SMS.
        responseData = {
          success: true,
          status: "ALERT_ACCEPTED",
          message: "Mock alert accepted for testing. No SMS was sent.",
          locationUrl,
        };
      } else {
        const response = await fetch(EMERGENCY_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        let parsedResponse = null;
        try {
          parsedResponse = await response.json();
        } catch {
          parsedResponse = null;
        }

        if (!response.ok) {
          throw new Error(
            parsedResponse?.message ||
              `The emergency service returned HTTP ${response.status}.`
          );
        }

        responseData = parsedResponse;
      }

      lastEmergencyRequestAtRef.current = Date.now();
      setEmergencyStatus({
        type: responseData?.success ? "success" : "error",
        message:
          responseData?.message ||
          (responseData?.success
            ? "The emergency alert was accepted by the service."
            : "The emergency alert could not be submitted."),
        locationUrl: responseData?.locationUrl || locationUrl,
      });
    } catch (error) {
      setEmergencyStatus({
        type: "error",
        message: error.message || "Could not submit the emergency alert.",
        locationUrl: null,
      });
    } finally {
      emergencyInProgressRef.current = false;
    }
  }

  // Both the manual SOS button and the future Member 1 callback should call
  // this same handler. Do not connect real SMS until Member 3 confirms readiness.
  function handleEmergencyClick() {
    submitEmergencyAlert();
  }

  return (
    <main className="console">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="IrisVocal home">
          <span className="brand-mark" aria-hidden="true">◉</span>
          <span className="brand-name">Iris<span>Vocal</span></span>
        </a>

        <div className="topbar-divider" />

        <div className="system-label">
          <span className="system-indicator" />
          <span>ASSISTIVE COMMUNICATION</span>
        </div>

        <div className="topbar-spacer" />

        <span className="tracking-status">
          <span className="status-light" />
          Tracking not connected
        </span>

        <button
          type="button"
          className="sos-button"
          onClick={handleEmergencyClick}
          disabled={emergencyStatus.type === "loading"}
          aria-label="Send emergency alert"
        >
          {emergencyStatus.type === "loading" ? "…" : "SOS"}
        </button>
      </header>

      <section className="message-strip" aria-live="polite">
        <span className="message-speaker" aria-hidden="true">◖))</span>

        <div className="message-content">
          <span className="message-label">MESSAGE</span>
          <p>
            {selectedPhrase
              ? selectedPhrase.text
              : "Select a phrase to communicate"}
          </p>
          {emergencyStatus.message && (
            <p
              className={`emergency-status emergency-status--${emergencyStatus.type}`}
              role="status"
              aria-live="polite"
            >
              {emergencyStatus.message}
              {emergencyStatus.locationUrl && (
                <>
                  {" "}
                  <a
                    href={emergencyStatus.locationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View location
                  </a>
                </>
              )}
            </p>
          )}
        </div>

        <button
          type="button"
          className="speak-button"
          disabled={!selectedPhrase}
          onClick={() => selectedPhrase && speakPhrase(selectedPhrase.text)}
          aria-label="Speak selected phrase"
        >
          <span aria-hidden="true">▶</span>
          <span>Speak</span>
        </button>
      </section>

      <div className="workspace">
        <aside className="category-rail" aria-label="Phrase categories">
          <p className="rail-heading">CATEGORIES</p>

          {categories.map((category) => (
            <button
              key={category}
              type="button"
              className={`rail-button ${
                activeCategory === category ? "active" : ""
              }`}
              onClick={() => setActiveCategory(category)}
              aria-pressed={activeCategory === category}
            >
              <span className="rail-symbol" aria-hidden="true">
                {category === "All" ? "▦" :
                  category === "General" ? "○" :
                  category === "Health" ? "+" :
                  category === "Social" ? "◇" : "!"}
              </span>
              <span>{category}</span>
            </button>
          ))}

          <div className="rail-note">
            <span className="rail-note-dot" />
            <span>Phrase board</span>
          </div>
        </aside>

        <section className="board-section">
          <div className="board-heading">
            <div>
              <p className="section-kicker">COMMUNICATION BOARD</p>
              <h1>What would you like to say?</h1>
              <p className="board-subtitle">
                Choose a message. It will be spoken aloud.
              </p>
            </div>

            <span className="tile-count">
              {visiblePhrases.length} MESSAGES
            </span>
          </div>

          <div className="phrase-grid">
            {visiblePhrases.map((phrase, index) => (
              <article
                key={phrase.id}
                className={`phrase-card ${
                  selectedPhrase?.id === phrase.id ? "selected" : ""
                }`}
              >
                <button
                  type="button"
                  className="phrase-select"
                  onClick={() => handlePhraseSelect(phrase)}
                  aria-pressed={selectedPhrase?.id === phrase.id}
                >
                  <span className="tile-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>

                  <span className="tile-icon" aria-hidden="true">
                    {phrase.icon}
                  </span>

                  <span className="phrase-text">{phrase.text}</span>

                  <span className="tile-category">{phrase.category}</span>
                </button>

                <div className="phrase-tools">
                  <button
                    type="button"
                    onClick={() => startEditing(phrase)}
                    aria-label={`Edit ${phrase.text}`}
                    title="Edit phrase"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePhrase(phrase.id)}
                    aria-label={`Delete ${phrase.text}`}
                    title="Delete phrase"
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>

          {visiblePhrases.length === 0 && (
            <div className="empty-state">
              No messages in this category. Add a phrase below.
            </div>
          )}

          <div className="board-footer">
            <span>IRISVOCAL / COMMUNICATION INTERFACE</span>
            <span>SELECT A TILE TO SPEAK</span>
          </div>
        </section>

        <aside className="utility-rail">
          <section className="preview-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">CAMERA MODULE</p>
                <h2>Eye tracking</h2>
              </div>
              <span className="preview-indicator" />
            </div>

            <div className="camera-placeholder">
              <span className="camera-symbol" aria-hidden="true">◎</span>
              <p>Camera preview</p>
              <span>Awaiting tracking integration</span>
            </div>

            <p className="preview-caption">
              Live gaze and dwell feedback will appear here when connected.
            </p>
          </section>

          <section className="utility-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">PERSONALIZATION</p>
                <h2>{editingId !== null ? "Edit message" : "Add a message"}</h2>
              </div>
              <span className="utility-symbol" aria-hidden="true">＋</span>
            </div>

            {editingId !== null ? (
              <form className="phrase-form" onSubmit={saveEdit}>
                <label htmlFor="edit-phrase">Message text</label>
                <input
                  id="edit-phrase"
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  maxLength={120}
                  required
                />

                <label htmlFor="edit-category">Category</label>
                <select
                  id="edit-category"
                  value={editCategory}
                  onChange={(event) => setEditCategory(event.target.value)}
                >
                  {categories.filter((c) => c !== "All").map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>

                <button type="submit" className="primary-action">
                  Save changes
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => {
                    setEditingId(null);
                    setEditText("");
                  }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <p className="utility-description">
                  Create a message that suits your everyday needs.
                </p>

                <form className="phrase-form" onSubmit={addPhrase}>
                  <label htmlFor="new-phrase">Message text</label>
                  <input
                    id="new-phrase"
                    value={newPhrase}
                    onChange={(event) => setNewPhrase(event.target.value)}
                    placeholder="e.g. Please open the window"
                    maxLength={120}
                    required
                  />

                  <label htmlFor="new-category">Category</label>
                  <select
                    id="new-category"
                    value={newCategory}
                    onChange={(event) => setNewCategory(event.target.value)}
                  >
                    {categories.filter((c) => c !== "All").map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>

                  <button type="submit" className="primary-action">
                    <span aria-hidden="true">＋</span> Add message
                  </button>
                </form>
              </>
            )}
          </section>

          <section className="accessibility-note">
            <span className="note-symbol" aria-hidden="true">i</span>
            <p>
              Designed for accessible communication. Use a keyboard or
              compatible pointing device until gaze control is connected.
            </p>
          </section>
        </aside>
      </div>

      <footer className="console-footer">
        <span>IRISVOCAL</span>
        <span>ACCESSIBILITY · COMMUNICATION · INDEPENDENCE</span>
      </footer>
    </main>
  );
}

export default App;
