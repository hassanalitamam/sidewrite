import { useState } from "react";

export default function ContactBlock() {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    type: "General",
    message: "",
    company: "",
    page_url: "",
  });

  const [selectedFiles, setSelectedFiles] = useState([]);
  const [fileError, setFileError] = useState(null);
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

  const handleFileChange = (e) => {
    const newFiles = Array.from(e.target.files || []);
    setFileError(null);

    // Validate each file being added
    for (const file of newFiles) {
      // Check if adding this file would exceed 3 files total
      if (selectedFiles.length + newFiles.indexOf(file) >= 3) {
        setFileError("Maximum 3 files per submission");
        return;
      }

      // Check individual file size (2MB limit)
      if (file.size > 2 * 1024 * 1024) {
        setFileError(`File "${file.name}" exceeds 2MB limit`);
        return;
      }

      // Check combined size (3MB limit)
      const currentCombinedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
      if (currentCombinedSize + file.size > 3 * 1024 * 1024) {
        setFileError("Combined file size exceeds 3MB limit");
        return;
      }
    }

    // Add valid files to the list
    setSelectedFiles((prev) => {
      const newList = [...prev, ...newFiles];
      // Still enforce max 3 files total
      if (newList.length > 3) {
        setFileError("Maximum 3 files per submission");
        return prev;
      }
      return newList.slice(0, 3);
    });
  };

  const removeFile = (index) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setFileError(null);
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus(null);
    setFileError(null);

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      // Encode all selected files to base64
      const attachments = await Promise.all(
        selectedFiles.map((file) => {
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              // Strip the "data:..." prefix from readAsDataURL result
              const dataUrl = reader.result;
              const base64 = dataUrl.split(",")[1];
              resolve({
                filename: file.name,
                mime_type: file.type,
                data_base64: base64,
              });
            };
            reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
            reader.readAsDataURL(file);
          });
        })
      );

      // Capture page URL and honeypot value at submit time
      const submitData = {
        ...formData,
        page_url: window.location.href,
        company: formData.company,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

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
        setSelectedFiles([]);
      } else {
        setStatus("error");
      }
    } catch (err) {
      setFileError(err.message || "Failed to process files");
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ textAlign: "center" }}>
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

          {/* File upload field */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label
              htmlFor="attachments"
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#16181c",
              }}
            >
              Attachments <span style={{ fontSize: "12px", color: "#878d96" }}>(optional, max 3 files, 3MB total)</span>
            </label>
            <input
              type="file"
              id="attachments"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,text/plain,application/pdf"
              onChange={handleFileChange}
              disabled={loading}
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

          {/* File list with remove controls */}
          {selectedFiles.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "12px", color: "#878d96" }}>
                {selectedFiles.length} file{selectedFiles.length !== 1 ? "s" : ""} selected
              </div>
              {selectedFiles.map((file, index) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 10px",
                    background: "#f5f4f2",
                    border: "1px solid #e5e3dd",
                    fontSize: "13px",
                    color: "#5a6069",
                  }}
                >
                  <span>
                    {file.name} ({formatFileSize(file.size)})
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(index)}
                    disabled={loading}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#e05a26",
                      cursor: loading ? "not-allowed" : "pointer",
                      fontSize: "12px",
                      fontWeight: 600,
                      padding: "0",
                      textDecoration: "underline",
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* File error message */}
          {fileError && (
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
              {fileError}
            </div>
          )}

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
  );
}
