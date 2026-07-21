(function() {
  const savedTheme = localStorage.getItem('finora_theme');
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light-mode');
    document.addEventListener('DOMContentLoaded', () => {
      document.body.classList.add('light-mode');
      updateThemeUI(true);
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      updateThemeUI(false);
    });
  }
})();

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  if (isLight) {
    document.documentElement.classList.add('light-mode');
  } else {
    document.documentElement.classList.remove('light-mode');
  }
  localStorage.setItem('finora_theme', isLight ? 'light' : 'dark');
  updateThemeUI(isLight);
}

function updateThemeUI(isLight) {
  const btnText = document.getElementById('themeToggleText');
  const btnIcon = document.getElementById('themeToggleIcon');
  if (btnText) btnText.textContent = isLight ? 'Light' : 'Dark';
  if (btnIcon) btnIcon.textContent = isLight ? '☀️' : '🌙';
}
