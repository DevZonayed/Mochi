<template>
  <form data-testid="login-form" @submit.prevent>
    <input type="email" name="email" data-testid="email-field" v-model="email" aria-label="Email" />
    <input type="password" name="password" data-testid="password-field" v-model="password" aria-label="Password" />
    <button type="submit" data-testid="submit-button">Sign in</button>
  </form>
</template>

<script setup>
import { ref } from "vue";
const email = ref("");
const password = ref("");
</script>
