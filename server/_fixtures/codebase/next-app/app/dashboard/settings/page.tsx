export default function SettingsPage() {
  return (
    <form data-testid="settings-form">
      <input name="display_name" data-testid="display-name-field" aria-label="Display name" />
      <input type="file" name="avatar" data-testid="avatar-field" accept="image/*" />
      <button type="submit" data-testid="save-button">Save</button>
    </form>
  );
}
