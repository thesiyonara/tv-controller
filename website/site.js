const palettes = { cinema: 'Cinema', sand: 'Sand', plum: 'Plum', ocean: 'Ocean' };
document.querySelectorAll('[data-palette]').forEach(button => {
 button.addEventListener('click', () => {
  const key = button.dataset.palette, label = palettes[key];
  if (!label) return;
  const image = document.querySelector('#hero-screen');
  image.src = `assets/app-${key}.jpg`;
  image.alt = `TV Controller desktop app in the ${label} palette, with playback details, apps and remote controls`;
  document.querySelector('#palette-name').textContent = `${label} palette`;
  document.querySelectorAll('[data-palette]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
 });
});
