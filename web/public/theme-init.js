// Aplica o tema escolhido antes do primeiro desenho, para a tela não piscar.
try {
  var theme = localStorage.getItem('tablets:theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (e) {}
