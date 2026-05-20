<script>
  let email = "";
  let password = "";
</script>

<form data-testid="login-form" on:submit|preventDefault>
  <input type="email" name="email" data-testid="email-field" bind:value={email} aria-label="Email" />
  <input type="password" name="password" data-testid="password-field" bind:value={password} aria-label="Password" />
  <button type="submit" data-testid="submit-button">Sign in</button>
</form>
