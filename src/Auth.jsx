import { useState } from "react";
import "./Auth.css";

const API_BASE_URL = "http://localhost:8081";

async function readResponse(response) {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

function getErrorMessage(data, fallback) {
  return data?.message || data?.error || data?.detail || fallback;
}

export default function Auth({ onLoginSuccess }) {
  const [mode, setMode] = useState("login");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState({ type: "", message: "" });
  const [showPassword, setShowPassword] = useState(false);

  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({
    name: "",
    email: "",
    password: "",
    emergencyContactName: "",
    emergencyContactNumber: "",
  });

  function updateLogin(event) {
    setLoginForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  function updateRegister(event) {
    setRegisterForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setFeedback({ type: "", message: "" });
    setShowPassword(false);
  }

  async function handleRegister(event) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setFeedback({ type: "", message: "" });

    // Only registration sends emergency contact details.
    const payload = {
      name: registerForm.name.trim(),
      email: registerForm.email.trim(),
      password: registerForm.password,
      emergencyContactName: registerForm.emergencyContactName.trim(),
      emergencyContactNumber: registerForm.emergencyContactNumber.trim(),
    };

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(data, `Registration failed (HTTP ${response.status}).`));
      }

      setFeedback({
        type: "success",
        message: data?.message || "Registration request succeeded. You can now try logging in.",
      });
      setLoginForm((current) => ({ ...current, email: payload.email, password: "" }));
      setRegisterForm({
        name: "",
        email: "",
        password: "",
        emergencyContactName: "",
        emergencyContactNumber: "",
      });
      setMode("login");
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof TypeError
            ? "Could not reach the authentication server. Check that the Spring Boot backend is running at http://localhost:8081 and that CORS is configured."
            : error.message || "Registration failed. Please try again.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setFeedback({ type: "", message: "" });

    // Login sends only email and password, never emergency-contact fields.
    const payload = {
      email: loginForm.email.trim(),
      password: loginForm.password,
    };

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readResponse(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(data, `Login failed (HTTP ${response.status}).`));
      }

      setFeedback({
        type: "success",
        message: data?.message || "Login request succeeded.",
      });
      // Response/token handling is intentionally delegated until Member 3 confirms
      // the final authentication response format and mechanism.
      if (typeof onLoginSuccess === "function") {
        onLoginSuccess({ data, email: payload.email });
      }
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof TypeError
            ? "Could not reach the authentication server. Check that the Spring Boot backend is running at http://localhost:8081 and that CORS is configured."
            : error.message || "Login failed. Please check your details and try again.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="iris-auth-page">
      <section className="iris-auth-card" aria-labelledby="iris-auth-title">
        <div className="iris-auth-brand">
          <div className="iris-auth-mark" aria-hidden="true">◉</div>
          <div>
            <div className="iris-auth-brand-name">IrisVocal</div>
            <div className="iris-auth-brand-caption">Communication, made accessible</div>
          </div>
        </div>

        <div className="iris-auth-intro">
          <p className="iris-auth-eyebrow">YOUR PERSONAL COMMUNICATION SPACE</p>
          <h1 id="iris-auth-title">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
          <p>{mode === "login" ? "Sign in to continue to IrisVocal." : "Set up your profile and trusted emergency contact."}</p>
        </div>

        <div className="iris-auth-tabs" role="tablist" aria-label="Account access">
          <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>Login</button>
          <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "active" : ""} onClick={() => switchMode("register")}>Register</button>
        </div>

        {feedback.message && (
          <div className={`iris-auth-feedback ${feedback.type}`} role="status" aria-live="polite">
            {feedback.message}
          </div>
        )}

        {mode === "login" ? (
          <form className="iris-auth-form" onSubmit={handleLogin}>
            <label htmlFor="login-email">Email address</label>
            <input id="login-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" value={loginForm.email} onChange={updateLogin} required />

            <label htmlFor="login-password">Password</label>
            <div className="iris-auth-password-wrap">
              <input id="login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Enter your password" value={loginForm.password} onChange={updateLogin} required />
              <button type="button" className="iris-auth-show-password" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button>
            </div>

            <button className="iris-auth-submit" type="submit" disabled={loading}>{loading ? "Please wait…" : "Login securely"}</button>
            <p className="iris-auth-switch-copy">New to IrisVocal? <button type="button" onClick={() => switchMode("register")}>Create an account</button></p>
          </form>
        ) : (
          <form className="iris-auth-form" onSubmit={handleRegister}>
            <div className="iris-auth-field-grid">
              <div className="iris-auth-field full">
                <label htmlFor="register-name">Full name</label>
                <input id="register-name" name="name" type="text" autoComplete="name" placeholder="Your full name" value={registerForm.name} onChange={updateRegister} required />
              </div>
              <div className="iris-auth-field full">
                <label htmlFor="register-email">Email address</label>
                <input id="register-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" value={registerForm.email} onChange={updateRegister} required />
              </div>
              <div className="iris-auth-field full">
                <label htmlFor="register-password">Password</label>
                <div className="iris-auth-password-wrap">
                  <input id="register-password" name="password" type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Create a password" value={registerForm.password} onChange={updateRegister} minLength={8} required />
                  <button type="button" className="iris-auth-show-password" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button>
                </div>
                <span className="iris-auth-hint">Use at least 8 characters.</span>
              </div>
            </div>

            <div className="iris-auth-contact-heading">
              <span className="iris-auth-contact-icon" aria-hidden="true">♡</span>
              <div><h2>Emergency contact</h2><p>Saved to your account during registration.</p></div>
            </div>

            <div className="iris-auth-field-grid">
              <div className="iris-auth-field">
                <label htmlFor="emergency-contact-name">Contact name</label>
                <input id="emergency-contact-name" name="emergencyContactName" type="text" autoComplete="off" placeholder="e.g. Mother" value={registerForm.emergencyContactName} onChange={updateRegister} required />
              </div>
              <div className="iris-auth-field">
                <label htmlFor="emergency-contact-number">Contact number</label>
                <input id="emergency-contact-number" name="emergencyContactNumber" type="tel" autoComplete="tel" placeholder="+919876543210" value={registerForm.emergencyContactNumber} onChange={updateRegister} pattern="[+]?[0-9 ()-]{7,20}" title="Enter a valid phone number, including country code if possible." required />
              </div>
            </div>

            <button className="iris-auth-submit" type="submit" disabled={loading}>{loading ? "Creating account…" : "Create account"}</button>
            <p className="iris-auth-switch-copy">Already registered? <button type="button" onClick={() => switchMode("login")}>Login</button></p>
          </form>
        )}

        <p className="iris-auth-privacy">Your emergency contact is provided during registration and should be securely associated with your account by the backend.</p>
      </section>
      <p className="iris-auth-footer">IrisVocal · Accessible communication for everyone</p>
    </main>
  );
}
