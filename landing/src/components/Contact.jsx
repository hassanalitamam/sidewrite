import { useState } from "react";
import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";

const mono = "'IBM Plex Mono', monospace";

export default function Contact() {
  const m = useIsMobile();
  const s = layout(m);

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    type: "General",
    message: "",
    company: "",
    page_url: "",
  });

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null); // "success", "error", or null

  const charCount = formData.message.length;
  const maxChars = 5000;

  const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const validateForm = () => {
    if (!formData.name.trim()) {
      alert("Please enter your name");
      return false;
    }
    if (!formData.email.trim()) {
      alert("Please enter your email");
      return false;
    }
    if (!validateEmail(formData.email)) {
      alert("Please enter a valid email address");
      return false;
    }
    if (!formData.message.trim()) {
      alert("Please enter a message");
      return false;
    }
    return true;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus(null);

    if (!validateForm()) {
      return;
    }

    // Capture page URL and honeypot value at submit time
    const submitData = {
      ...formData,
      page_url: window.location.href,
      company: formData.company,
    };

    setLoading(true);

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(submitData),
      });

      if (response.ok) {
        setStatus("success");
        setFormData({
          name: "",
          email: "",
          type: "General",
          message: "",
          company: "",
          page_url: "",
        });
      } else {
        setStatus("error");
      }
    } catch (err) {
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section id="v3-contact" style={{ borderBottom: "1px solid #e5e3dd", background: "#ffffff" }}>
      <div style={s.installOuter}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "20px", marginBottom: "32px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>/06</span>
          <h2 style={s.installH2}>Contact us</h2>
        </div>
        <p style={{ fontSize: "16px", color: "#5a6069", margin: "0 0 40px" }}>
          Have questions or found an issue? We'd love to hear from you.
        </p>

        <form
          onSubmit={handleSubmit}
          style={{
            maxWidth: "600px",
            margin: "0 auto",
            textAlign: "left",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          {/* Honeypot field */}
          <input
            type="text"
            name="company"
            value={formData.company}
            onChange={handleChange}
            style={{
              position: "absolute",
              left: "-9999px",
            }}
            tabIndex="-1"
            autoComplete="off"
            aria-hidden="true"
          />

          {/* Name field */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label
              htmlFor="name"
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#16181c",
              }}
            >
              Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              required
              style={{
                padding: "10px 14px",
                fontSize: "14px",
                border: "1px solid #d9d6cf",
                background: "#ffffff",
                fontFamily: "inherit",
                color: "#16181c",
              }}
            />
          </div>

          {/* Email field */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label
              htmlFor="email"
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#16181c",
              }}
            >
              Email
            </label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              style={{
                padding: "10px 14px",
                fontSize: "14px",
                border: "1px solid #d9d6cf",
                background: "#ffffff",
                fontFamily: "inherit",
                color: "#16181c",
              }}
            />
          </div>

          {/* Type field */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label
              htmlFor="type"
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#16181c",
              }}
            >
              Message type
            </label>
            <select
              id="type"
              name="type"
              value={formData.type}
              onChange={handleChange}
              style={{
                padding: "10px 14px",
                fontSize: "14px",
                border: "1px solid #d9d6cf",
                background: "#ffffff",
                fontFamily: "inherit",
                color: "#16181c",
              }}
            >
              <option value="General">General inquiry</option>
              <option value="Report an issue">Report an issue</option>
            </select>
          </div>

          {/* Message field */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label
              htmlFor="message"
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#16181c",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>Message</span>
              <span style={{ fontSize: "12px", color: "#878d96" }}>
                {charCount} / {maxChars}
              </span>
            </label>
            <textarea
              id="message"
              name="message"
              value={formData.message}
              onChange={handleChange}
              maxLength={maxChars}
              required
              rows={6}
              style={{
                padding: "10px 14px",
                fontSize: "14px",
                border: "1px solid #d9d6cf",
                background: "#ffffff",
                fontFamily: "inherit",
                color: "#16181c",
                resize: "vertical",
              }}
            />
          </div>

          {/* Status messages */}
          {status === "success" && (
            <div
              style={{
                padding: "12px 14px",
                background: "#e8f5e9",
                border: "1px solid #4caf50",
                color: "#2e7d32",
                fontSize: "14px",
                borderRadius: "2px",
              }}
            >
              Thanks for reaching out! We'll get back to you soon.
            </div>
          )}

          {status === "error" && (
            <div
              style={{
                padding: "12px 14px",
                background: "#ffebee",
                border: "1px solid #f44336",
                color: "#c62828",
                fontSize: "14px",
                borderRadius: "2px",
              }}
            >
              Something went wrong. Please try again later.
            </div>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={loading}
            style={{
              alignSelf: "flex-start",
              padding: "10px 24px",
              background: loading ? "#c5a17a" : "#e05a26",
              color: "#f6f5f2",
              border: "none",
              fontSize: "14px",
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background 0.15s ease",
              fontFamily: "inherit",
            }}
            className="sw-cta"
            onMouseEnter={(e) => {
              if (!loading) e.target.style.background = "#ff8557";
            }}
            onMouseLeave={(e) => {
              if (!loading) e.target.style.background = "#e05a26";
            }}
          >
            {loading ? "Sending..." : "Send message"}
          </button>
        </form>
      </div>
    </section>
  );
}
