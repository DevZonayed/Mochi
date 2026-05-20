"use client";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form data-testid="login-form" onSubmit={() => {}}>
      <input type="email" name="email" data-testid="email-field" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" name="password" data-testid="password-field" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit" data-testid="submit-button">Sign in</button>
    </form>
  );
}
